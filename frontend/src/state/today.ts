/**
 * "Today" as the server knows it: the date in the person's time zone, the notes, the page, the values, the streak.
 * Shared by the page "Today" and the quick note. Loaded again when the tab comes back into view (the phone was put away
 * last night, the day changed meanwhile) and when the time zone of the account changes.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, diaryApi, photosApi, promptsApi, type Night, type Note, type Photo, type Question, type TodayData } from '../api/client'
import { newId } from '../lib/ids'
import { uploadPhoto } from '../lib/upload'
import { useAuth } from './auth'

/** The text as the server keeps it: line breaks as \n, no control characters, no space at the ends. */
export function cleanNote(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim()
}

function codeOf(error: unknown): string {
  return error instanceof ApiError ? error.code : 'internal_error'
}

function valuesOf(error: unknown): Record<string, unknown> {
  return error instanceof ApiError ? error.values : {}
}

export function useToday() {
  const { me } = useAuth()
  const zone = me?.profile?.timezone
  const [data, setData] = useState<TodayData | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  /** What the server said with the problem (the largest size of a photo, say), for its sentence. */
  const [problemValues, setProblemValues] = useState<Record<string, unknown>>({})
  /** The id the next note goes out with. It stays the same until the server took the note, so a second send of the
   * same text (Enter twice, a double tap) is the same note. */
  const draftId = useRef(newId())
  /** The text (and photo) the current id went out with, while its answer is unknown (a send that failed or got no
   * answer). */
  const draftText = useRef<string | null>(null)
  const sending = useRef(false)
  /** After midnight, with no answer yet: the page asks which day the notes belong to before the first note goes out.
   * `asking` holds the question open; `waiting` is the note that waits for the answer. */
  const [asking, setAsking] = useState(false)
  const waiting = useRef<((choice: 'yesterday' | 'today' | null) => void) | null>(null)

  /** The night as the last answer of `/api/today` said it; null while that answer is not here yet (or failed). A note
   * does not go out on a guess: whether this is a night nobody was asked about is known from that answer only. */
  const nightState = useRef<Night | null>(null)
  /** The day the page shows, as the last answer of `/api/today` said it (read by notes sent one after another, which
   * do not wait for the page to render in between). */
  const shownDay = useRef<string | null>(null)
  /** The load in flight (or the last one), so that a note sent before the first answer can wait for it. */
  const loading = useRef<Promise<void> | null>(null)

  const load = useCallback((): Promise<void> => {
    const run = (async () => {
      try {
        const fresh = await diaryApi.today()
        nightState.current = fresh.night ?? { active: false }
        shownDay.current = fresh.date
        setData(fresh)
        setProblem(null)
      } catch (error) {
        setProblem(codeOf(error))
        setProblemValues(valuesOf(error))
      }
    })()
    loading.current = run
    return run
  }, [])

  useEffect(() => {
    void load()
  }, [load, zone])

  useEffect(() => {
    const again = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', again)
    return () => document.removeEventListener('visibilitychange', again)
  }, [load])

  /** Opens the question "which day?" and gives the answer (null: put away). Asked once for a night: the server keeps
   * the answer until 4 o'clock, for every device. */
  const askNight = useCallback(
    () =>
      new Promise<'yesterday' | 'today' | null>((resolve) => {
        waiting.current?.(null)
        waiting.current = resolve
        setAsking(true)
      }),
    [],
  )

  /** The answer to the question, or a later change of mind (the hint's button): kept by the server, then the day is
   * loaded again, for it may now be yesterday. */
  const chooseNight = useCallback(
    async (choice: 'yesterday' | 'today' | null) => {
      const resolve = waiting.current
      waiting.current = null
      setAsking(false)
      if (choice === null) {
        resolve?.(null)
        return false
      }
      try {
        await diaryApi.night(choice)
        await load()
        setProblem(null)
        resolve?.(choice)
        return true
      } catch (error) {
        setProblem(codeOf(error))
        setProblemValues(valuesOf(error))
        resolve?.(null)
        void load()
        return false
      }
    },
    [load],
  )

  /**
   * Keeps a note; true only when the server holds exactly this text, so that the field is emptied only then. The same
   * text sent again (a double tap, a retry after a lost answer) goes out with the same id and stays one note. A text
   * changed after a send whose answer was lost gets a new id: the old id may already hold the old text.
   */
  /** Whether a note may go out now: false when the day is not known, or after midnight the question "which day?" was
   * put away. */
  const dayChosen = useCallback(async (): Promise<boolean> => {
    // Not known yet whether this is a night nobody was asked about (the page was just opened, the answer of the server
    // is on its way): wait for it instead of guessing. The text stays in the field meanwhile. If it cannot be had, the
    // note does not go out either; the page says why and the text is still there.
    if (nightState.current === null) {
      await (loading.current ?? load())
      if (nightState.current === null) await load()
      if (nightState.current === null) return false
    }
    // After midnight and not yet answered: which day do the notes of this night belong to?
    const night = nightState.current
    return !(night.active && night.choice === null && !(await askNight()))
  }, [load, askNight])

  const addNote = useCallback(async (text: string, photoId: string | null = null, prompt: Question | null = null): Promise<boolean> => {
    const clean = cleanNote(text)
    if ((!clean && !photoId) || sending.current) return false
    if (!(await dayChosen())) return false
    if (sending.current) return false
    sending.current = true
    try {
      const sent = `${clean}|${photoId ?? ''}|${prompt?.id ?? ''}`
      if (draftText.current !== null && draftText.current !== sent) draftId.current = newId()
      draftText.current = sent
      let note: Note
      try {
        // No date: the server keeps it on its own "today", which may have moved on since the page was loaded.
        note = await diaryApi.addNote(draftId.current, clean, undefined, photoId, prompt)
      } catch (error) {
        // The id holds another text already: this text is a note of its own.
        if (!(error instanceof ApiError && error.code === 'note_id_taken')) throw error
        draftId.current = newId()
        note = await diaryApi.addNote(draftId.current, clean, undefined, photoId, prompt)
      }
      if (note.text !== clean) {
        setProblem('note_id_taken')
        return false
      }
      draftId.current = newId()
      draftText.current = null
      // An answer to the question of the day: the server asks the next one, which comes with the day loaded again.
      if (note.date !== shownDay.current || prompt) void load()
      else setData((current) => (current && !current.notes.some((item) => item.id === note.id) ? { ...current, notes: [...current.notes, note] } : current))
      setProblem(null)
      return true
    } catch (error) {
      setProblem(codeOf(error))
      setProblemValues(valuesOf(error))
      return false
    } finally {
      sending.current = false
    }
  }, [load, dayChosen])

  const changeNote = useCallback(async (id: string, text: string) => {
    try {
      const note = await diaryApi.changeNote(id, text)
      setData((current) => (current ? { ...current, notes: current.notes.map((item) => (item.id === id ? note : item)) } : current))
      setProblem(null)
    } catch (error) {
      setProblem(codeOf(error))
      setProblemValues(valuesOf(error))
      void load()
    }
  }, [load])

  /** A note to the day before or the day after its own; it leaves this day's list. Said in `moved`. */
  const [moved, setMoved] = useState<string | null>(null)
  const moveNote = useCallback(async (id: string, direction: 'previous' | 'next') => {
    try {
      const note = await diaryApi.moveNote(id, direction)
      setData((current) => (current ? { ...current, notes: current.notes.filter((item) => item.id !== id) } : current))
      setMoved(note.date)
      setProblem(null)
      void load()
    } catch (error) {
      setProblem(codeOf(error))
      setProblemValues(valuesOf(error))
    }
  }, [load])

  const deleteNote = useCallback(async (id: string) => {
    setData((current) => (current ? { ...current, notes: current.notes.filter((item) => item.id !== id) } : current))
    try {
      await diaryApi.deleteNote(id)
      setProblem(null)
    } catch (error) {
      setProblem(codeOf(error))
      setProblemValues(valuesOf(error))
      void load()
    }
  }, [load])

  /** A rating from 1 to 10, or null to take it back; shown at once, put right if the server refuses. */
  const rate = useCallback(async (valueId: string, rating: number | null) => {
    if (!data) return
    const date = data.date
    setData((current) => {
      if (!current) return current
      const values = { ...(current.day?.values ?? {}) }
      if (rating === null) delete values[valueId]
      else values[valueId] = rating
      const day = current.day ?? { date, title: '', text: '', tags: [], values: {}, cover: '', cover_chosen: false, written_by: null, words: 0, revision: -1, created_at: '', updated_at: '' }
      return { ...current, day: { ...day, values } }
    })
    try {
      const day = await diaryApi.rate(date, { [valueId]: rating })
      setData((current) => (current && current.date === date ? { ...current, day } : current))
      setProblem(null)
    } catch (error) {
      setProblem(codeOf(error))
      setProblemValues(valuesOf(error))
      void load()
    }
  }, [data, load])

  const setTags = useCallback(async (tags: string[]) => {
    if (!data) return
    const date = data.date
    try {
      const day = await diaryApi.changeDay(date, { tags })
      setData((current) => (current && current.date === date ? { ...current, day } : current))
      setProblem(null)
    } catch (error) {
      setProblem(codeOf(error))
      setProblemValues(valuesOf(error))
    }
  }, [data])

  /** A photo of today, uploaded (for a note, or for the day); null when the server refused it (the page says why). */
  const addPhoto = useCallback(async (file: Blob, forNote = false): Promise<Photo | null> => {
    try {
      const photo = await uploadPhoto(file, undefined, forNote)
      setData((current) => (current && current.date === photo.date && !current.photos.some((item) => item.id === photo.id) ? { ...current, photos: [...current.photos, photo] } : current))
      setProblem(null)
      return photo
    } catch (error) {
      setProblem(codeOf(error))
      setProblemValues(valuesOf(error))
      return null
    }
  }, [])

  /**
   * Photos shared from another app: each one a note of its own with its photo, the shared text in the first. Asked
   * "which day?" first after midnight, so that photo and note land on the same day. A photo the server refuses (not a
   * picture, too large, the storage full) is said as on any upload, and the others still become notes. Gives back the
   * text when no note took it, for the field.
   */
  const addShared = useCallback(async (photos: Blob[], text: string): Promise<string> => {
    if (!(await dayChosen())) {
      setProblem('share_no_day')
      setProblemValues({})
      return text
    }
    let left = text
    let refused: unknown = null
    for (const file of photos) {
      let photo: Photo
      try {
        photo = await uploadPhoto(file, undefined, true)
      } catch (error) {
        refused = error
        continue
      }
      setData((current) => (current && current.date === photo.date && !current.photos.some((item) => item.id === photo.id) ? { ...current, photos: [...current.photos, photo] } : current))
      if (await addNote(left, photo.id)) left = ''
      else return left
    }
    if (refused !== null) {
      setProblem(codeOf(refused))
      setProblemValues(valuesOf(refused))
    }
    return left
  }, [dayChosen, addNote])

  /** A photo the server holds already (taken from Immich): it joins the photos of the day. */
  const keepPhoto = useCallback((photo: Photo) => {
    setData((current) => (current && current.date === photo.date && !current.photos.some((item) => item.id === photo.id) ? { ...current, photos: [...current.photos, photo] } : current))
  }, [])

  /** Deletes a photo; its notes keep their words, a cover falls back to the illustration. */
  const deletePhoto = useCallback(async (id: string) => {
    setData((current) =>
      current ? { ...current, photos: current.photos.filter((item) => item.id !== id), notes: current.notes.map((note) => (note.photo_id === id ? { ...note, photo_id: null } : note)) } : current,
    )
    try {
      await photosApi.remove(id)
      setProblem(null)
    } catch (error) {
      setProblem(codeOf(error))
      setProblemValues(valuesOf(error))
      void load()
    }
  }, [load])

  /** Another question of the day, kept by the server for the rest of the day. */
  const anotherQuestion = useCallback(async () => {
    try {
      const { question } = await promptsApi.another()
      setData((current) => (current ? { ...current, question } : current))
      setProblem(null)
    } catch (error) {
      setProblem(codeOf(error))
      setProblemValues(valuesOf(error))
    }
  }, [])

  return { data, problem, problemValues, load, addNote, addShared, changeNote, moveNote, moved, clearMoved: () => setMoved(null), asking, chooseNight, deleteNote, rate, setTags, addPhoto, keepPhoto, deletePhoto, anotherQuestion }
}

export type TodayState = ReturnType<typeof useToday>
export type { Note }
