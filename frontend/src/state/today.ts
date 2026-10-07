/**
 * "Today" as the server knows it: the date in the person's time zone, the notes, the page, the values, the streak.
 * Shared by the page "Today" and the quick note. Loaded again when the tab comes back into view (the phone was put away
 * last night, the day changed meanwhile) and when the time zone of the account changes.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, diaryApi, photosApi, promptsApi, type Note, type Photo, type Question, type TodayData } from '../api/client'
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

  const load = useCallback(async () => {
    try {
      setData(await diaryApi.today())
      setProblem(null)
    } catch (error) {
      setProblem(codeOf(error))
      setProblemValues(valuesOf(error))
    }
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

  const shownDate = data?.date

  /**
   * Keeps a note; true only when the server holds exactly this text, so that the field is emptied only then. The same
   * text sent again (a double tap, a retry after a lost answer) goes out with the same id and stays one note. A text
   * changed after a send whose answer was lost gets a new id: the old id may already hold the old text.
   */
  const addNote = useCallback(async (text: string, photoId: string | null = null, prompt: Question | null = null): Promise<boolean> => {
    const clean = cleanNote(text)
    if ((!clean && !photoId) || sending.current) return false
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
      if (note.date !== shownDate || prompt) void load()
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
  }, [shownDate, load])

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

  return { data, problem, problemValues, load, addNote, changeNote, deleteNote, rate, setTags, addPhoto, keepPhoto, deletePhoto, anotherQuestion }
}

export type TodayState = ReturnType<typeof useToday>
export type { Note }
