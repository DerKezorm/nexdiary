/**
 * Writing a day up, as the mock's write view (`Today.tsx`, mode "schreiben"): title, cover, the text in the editor,
 * beside it the tags and the notes of the day. For today and for any day before (`/tag/:date/schreiben`).
 *
 * Nothing is lost on the way:
 * - **the draft** goes to the server while typing (sealed like the page, at most every few seconds), when the tab is
 *   hidden and when the page is left; opened again, the draft is back;
 * - **two devices**: a save names the revision it started from and sends only what was changed here; a field changed
 *   meanwhile elsewhere and not here stays as it is there, one changed in both places is not overwritten unseen: the
 *   page shows the other version (to copy from) and offers both ways;
 * - **a double click** on save saves once.
 *
 * On a phone "Save" stays at the bottom, above the keyboard; the menu bar of the app is not shown while writing. At the
 * computer the top bar (back, "draft kept", Save) and the editor's bar of formats are one bar that stays at the top while the
 * page scrolls, and Ctrl+S / Cmd+S saves (the browser's own "save page" is kept away).
 * A saved page can be locked for good from here; a locked day is not written on any more.
 * Loaded only when somebody writes: the editor is the heaviest part of the app.
 *
 * **The AI** writes only when asked: "Ausformulieren" on "Today" comes here with the length in the history state, which
 * is read once and cleared at once (a reload asks nothing); here the same button stands above the text of every day that
 * has notes and no page yet (the day before, written up after midnight). Over a draft or a changed suggestion it asks
 * first: keep it, or have it written anew. The suggestion lands in the editor as the writing, to be
 * changed at will; "Länger"/"Kürzer" asks anew. A page begun from a suggestion counts as written with the AI, edited
 * or not ("Mit KI ausformuliert" in the statistics): that is how it came about. The draft keeps it, the notes stay.
 * Beside the text the questions to insert ("Weiterschreiben?").
 *
 * **Templates**: a person with templates sees a line "Vorlage" above the text for as long as the page is empty or holds
 * only the unchanged frame of a template. The default one is preselected. A template puts its headings into the editor
 * (each with a line to write on, the question as a grey hint in it, `sections` of the editor); the AI buttons carry
 * the chosen one (`template`), and on saving the sections of the template that stayed empty fall away.
 */
import { Check, Crop, ImageIcon, Loader2, Lock, Shuffle, Sparkles, ZoomIn } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'

import { aiApi, ApiError, diaryApi, immichApi, NO_TEMPLATE, photosApi, photoUrl, promptsApi, templatesApi, type AiLength, type CoverCropValue, type DayChange, type DayPage, type DraftIn, type ImmichEntry, type ImmichPhoto, type Note, type Photo, type Question, type Template, type TemplateSet } from '../api/client'
import { CoverCropDialog } from '../components/CropEditor'
import { DayPhotoPicker } from '../components/DayPhotoPicker'
import { Dialog } from '../components/Dialog'
import { ImmichPicker } from '../components/ImmichPicker'
import { LockDialog, LockedMark } from '../components/LockDay'
import { useOwnPhotoViewer } from '../components/ownPhotoViewer'
import { TagPicker } from '../components/TagPicker'
import { CoverImage, CoverPicker, defaultCover } from '../covers/Cover'
import { timeOfHour, type Time } from '../covers/suggest'
import { DiaryEditor, type DiaryEditorHandle } from '../editor/DiaryEditor'
import { copyText } from '../lib/copy'
import { aiHint } from '../lib/aiProviders'
import { longDate, timeOf } from '../lib/dates'
import { errorText } from '../lib/errors'
import { scaffold, templateOf, tidy, untouchedText, withoutEmptySections } from '../lib/templates'
import { coverCropOf } from '../lib/textPhoto'
import { uploadPhoto } from '../lib/upload'
import { useAiState } from '../state/ai'
import { useAuth } from '../state/auth'
import { useImmichDay, useImmichReady } from '../state/immich'

/** After the last key, how long until the draft goes out; and the longest it waits while somebody types on. */
const DRAFT_PAUSE_MS = 1500
const DRAFT_LONGEST_MS = 8000

type Problem = { code: string; values?: Record<string, unknown> }
/** `cover_crop` belongs to the cover: it is sent with it, and a new cover starts without one. */
type Page = { title: string; text: string; tags: string[]; cover: string | null; cover_crop: CoverCropValue | null }
type Field = keyof Page
const FIELDS: Field[] = ['title', 'text', 'tags', 'cover', 'cover_crop']
/** keepalive carries at most 64 KB per page; a larger draft goes out as an ordinary request and the page warns. */
const KEEPALIVE_MAX = 60_000
const EMPTY: Page = { title: '', text: '', tags: [], cover: null, cover_crop: null }

/** The page as the server holds it, with the cover only when one was chosen. */
function pageOf(day: DayPage | null): Page {
  return day ? { title: day.title, text: day.text, tags: day.tags, cover: day.cover_chosen ? day.cover : null, cover_crop: day.cover_chosen ? coverCropOf(day.cover_crop) : null } : EMPTY
}

function same(a: Page[Field], b: Page[Field]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The date and the hour in a time zone, as the server counts "today". */
function nowIn(zone?: string): { date: string; hour: number } {
  const moment = new Date()
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(moment)
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ''
    return { date: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) }
  } catch {
    return { date: moment.toISOString().slice(0, 10), hour: moment.getHours() }
  }
}

/** What the question before the AI writes over something says: over a draft, over a changed suggestion, over a saved page. */
const REDO = {
  draft: { title: 'write.aiDraftTitle', text: 'write.aiDraftText', keep: 'write.aiDraftKeep', go: 'write.aiDraftAnew' },
  suggestion: { title: 'write.aiRedoTitle', text: 'write.aiRedoText', keep: 'common.cancel', go: 'write.aiRedoConfirm' },
  page: { title: 'write.aiPageTitle', text: 'write.aiPageText', keep: 'write.aiPageKeep', go: 'write.aiDraftAnew' },
} as const

/** The length "Ausformulieren" on "Today" asked for, carried in the history state; anything else is nothing. */
function askedLength(state: unknown): AiLength | null {
  const asked = state && typeof state === 'object' ? (state as { formulate?: unknown }).formulate : null
  return asked === 'short' || asked === 'long' ? asked : null
}

function codeOf(error: unknown): Problem {
  return error instanceof ApiError ? { code: error.code, values: error.values } : { code: 'internal_error' }
}

async function orNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/** The keyboard of a phone covers the bottom of the page in some browsers (Safari): how much of it, to lift "Save". */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const measure = () => setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)))
    measure()
    viewport.addEventListener('resize', measure)
    viewport.addEventListener('scroll', measure)
    return () => {
      viewport.removeEventListener('resize', measure)
      viewport.removeEventListener('scroll', measure)
    }
  }, [])
  return inset
}

export default function WritePage() {
  const { date = '' } = useParams()
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const ai = useAiState()
  const zone = me?.profile?.timezone
  const [today] = useState(() => nowIn(zone))
  const isToday = date === today.date
  const time: Time = isToday ? timeOfHour(today.hour) : 'abend'

  const [loaded, setLoaded] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [day, setDay] = useState<DayPage | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [photos, setPhotos] = useState<Photo[]>([])
  const [page, setPage] = useState<Page>(EMPTY)
  const [base, setBase] = useState(-1)
  /** A new editor when another version is loaded into it. */
  const [editorKey, setEditorKey] = useState(0)
  const [restored, setRestored] = useState<string | null>(null)
  const [kept, setKept] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<DayPage | null>(null)
  const [copied, setCopied] = useState(false)
  const [editorEmpty, setEditorEmpty] = useState(true)
  const [picking, setPicking] = useState(false)
  /** The cut of the cover photo being chosen. */
  const [cropping, setCropping] = useState(false)
  /** Where a picture for the text or the cover is picked from: the whole collection of the own Immich, or the photos
   * kept for the day. */
  const [chooser, setChooser] = useState<'text' | 'cover' | 'day' | null>(null)
  const [imaging, setImaging] = useState(false)
  const immichReady = useImmichReady()
  /** The draft that stands is one the morning writing made and nobody has accepted yet. */
  const [autoDraft, setAutoDraft] = useState(false)
  // The photos of the day in the own Immich, asked for only while the cover is being chosen.
  const immich = useImmichDay(date, picking)
  const [uploading, setUploading] = useState(false)
  const inset = useKeyboardInset()
  const editor = useRef<DiaryEditorHandle>(null)
  /** Where the editor puts its bar of formats: into the sticky top bar, so that both stay at the top together. */
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null)
  const [locking, setLocking] = useState(false)
  /** While the AI writes the suggestion. */
  const [formulating, setFormulating] = useState(false)
  /** Asking before the AI writes over something: the length asked for, and whether a draft or a changed suggestion
   * stands. */
  const [redo, setRedo] = useState<{ length: AiLength; over: 'draft' | 'suggestion' | 'page' } | null>(null)
  const [length, setLength] = useState<AiLength>('long')
  /** The person's templates (none: an empty list) and the one the page is written under, by its id. */
  const [templateSet, setTemplateSet] = useState<TemplateSet | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const titleField = useRef<HTMLTextAreaElement>(null)
  /** How this writing came about: from a suggestion of the AI (and the length asked for), or not. Kept with the draft. */
  const [origin, setOrigin] = useState<{ by: 'ai' | null; length: AiLength }>({ by: null, length: 'long' })
  /** The press of "Ausformulieren" that led here, taken once; and the text of the last suggestion. */
  const wanted = useRef<AiLength | null>(askedLength(location.state))
  const suggested = useRef<{ title: string; text: string } | null>(null)
  const askingAi = useRef(false)

  const templates = templateSet?.templates ?? []
  const chosenTemplate: Template | null = templates.find((template) => template.id === chosen) ?? null
  const sections = chosenTemplate?.sections ?? null
  /** What the AI is told: the chosen template, "none" for a person who has templates and wants none, nothing for a
   * person without templates (then the server's own default counts, and there is none). */
  const templateParam = templates.length > 0 ? (chosenTemplate?.id ?? NO_TEMPLATE) : undefined
  /** Nothing of the person's is on the page: no title, and no text or only the frame of a template. */
  const isBlank = (now: Page) => !now.title.trim() && untouchedText(now.text, templates)
  /** The editor writes an empty paragraph as extra line breaks; under a template those are no change of the text. */
  const sameText = (a: string, b: string) => (sections ? tidy(a) === tidy(b) : a === b)

  /** What the page holds right now, for the timers and handlers that outlive a render. */
  const latest = useRef({ page, base, origin })
  useEffect(() => {
    latest.current = { page, base, origin }
  })
  /** The server's page this writing started from; null when it is not known (a draft from an older revision). */
  const started = useRef<Page | null>(EMPTY)
  /** What was changed here: only these fields are sent, every other one stays as the server has it. */
  const touched = useRef(new Set<Field>())
  const sentDraft = useRef('')
  const pending = useRef(false)
  const pause = useRef<number | undefined>(undefined)
  const longest = useRef<number | undefined>(undefined)
  const savingNow = useRef(false)
  const done = useRef(false)

  /** The photos of the day itself (not those that came with a note): the first of them is the cover to begin with,
   * else the illustration that fits. */
  const dayPhotos = photos.filter((photo) => !photo.on_note && !notes.some((note) => note.photo_id === photo.id))
  const shownCover = page.cover ?? defaultCover(date, page.tags, dayPhotos, time)
  /** The photo the cover is, when it is one of the day's (its cut can be chosen). */
  const coverPhoto = shownCover.startsWith('photo:') ? (photos.find((photo) => `photo:${photo.id}` === shownCover) ?? null) : null

  // --- Templates ----------------------------------------------------------------------------------------------------

  /** Chooses the template for the page as it stands in ``latest``: an empty page begins under the default one (its
   * frame goes into the text, which is no change of the person's: nothing is marked, no draft is made), a text that was
   * written under a template keeps it, any other text has none. */
  const framePage = (set: TemplateSet | null) => {
    const own = set?.templates ?? []
    const now = latest.current.page
    let picked: Template | null = null
    if (own.length > 0) {
      const empty = !now.text.trim()
      picked = empty ? (own.find((template) => template.id === set?.default) ?? null) : templateOf(now.text, own, set?.default ?? null)
      if (picked && empty) {
        const framed = { ...now, text: scaffold(picked.sections) }
        latest.current = { ...latest.current, page: framed }
        setPage(framed)
      }
    }
    setChosen(picked?.id ?? null)
  }

  /** Another template (or none) while the page is still empty: its frame replaces the old one. */
  const pickTemplate = (id: string) => {
    // What was typed a moment ago is not in the page's text yet (the editor reports it after a pause): ask the editor.
    // If anything of the person's is there, nothing is swapped; the page takes the new text and the line goes.
    const live = editor.current?.getMarkdown()
    if (live != null && !untouchedText(live, templates)) {
      settled()
      return
    }
    const next = templates.find((template) => template.id === id) ?? null
    setChosen(next?.id ?? null)
    const framed = { ...latest.current.page, text: next ? scaffold(next.sections) : '' }
    latest.current = { ...latest.current, page: framed }
    setPage(framed)
    setEditorKey((key) => key + 1)
  }

  // --- Loading ------------------------------------------------------------------------------------------------------

  useEffect(() => {
    let gone = false
    void (async () => {
      try {
        const [found, dayNotes, dayPhotos, draft, ownTemplates] = await Promise.all([
          orNull(diaryApi.day(date)),
          diaryApi.notes(date),
          photosApi.list(date),
          diaryApi.draft(date),
          // Templates are a help, never a reason for the page not to open.
          templatesApi.get().catch(() => null),
        ])
        if (gone) return
        setDay(found)
        setNotes(dayNotes)
        setPhotos(dayPhotos)
        const server = pageOf(found)
        // A draft is writing that was never saved (a save ends it): it comes back, and names where it started.
        if (draft) {
          const kept: Page = { title: draft.title, text: draft.text, tags: draft.tags, cover: draft.cover, cover_crop: draft.cover ? coverCropOf(draft.cover_crop) : null }
          const from = { by: draft.written_by === 'ai' ? ('ai' as const) : null, length: draft.ai_length ?? ('long' as const) }
          setPage(kept)
          setOrigin(from)
          if (from.by === 'ai') suggested.current = null
          latest.current = { page: kept, base: draft.base_revision, origin: from }
          setBase(draft.base_revision)
          // What the draft holds differently from the page it started from was written here.
          started.current = draft.base_revision === (found?.revision ?? -1) ? server : null
          touched.current = new Set(FIELDS.filter((field) => !same(kept[field], (started.current ?? server)[field]) || started.current === null))
          sentDraft.current = JSON.stringify({ ...kept, base_revision: draft.base_revision })
          setRestored(timeOf(draft.updated_at, zone))
          setAutoDraft(Boolean(draft.auto))
        } else {
          setPage(server)
          latest.current = { page: server, base: found?.revision ?? -1, origin: latest.current.origin }
          setBase(found?.revision ?? -1)
          started.current = server
          touched.current = new Set()
        }
        setTemplateSet(ownTemplates)
        framePage(ownTemplates)
        setLoaded(true)
      } catch (error) {
        if (!gone) setProblem(codeOf(error))
      }
    })()
    return () => {
      gone = true
    }
  }, [date, zone])

  // --- The draft ----------------------------------------------------------------------------------------------------

  /** The page as it stands this moment, the newest words of the editor included (its `onChange` comes after a pause
   * in the typing, a tap on "Save" can come before). */
  const settled = (): Page => {
    // Trailing white space never counts: the editor's change report ends with a line break that its direct read may
    // not have, and which of the two came last depended on timing.
    const text = editor.current?.getMarkdown()?.replace(/\s+$/, '')
    if (text != null && !sameText(text, latest.current.page.text.replace(/\s+$/, ''))) {
      const page = { ...latest.current.page, text }
      latest.current = { ...latest.current, page }
      pending.current = true
      touched.current.add('text')
      setPage(page)
    }
    const page = latest.current.page
    return { ...page, text: page.text.replace(/\s+$/, '') }
  }

  const flush = async (keepalive = false) => {
    settled()
    window.clearTimeout(pause.current)
    window.clearTimeout(longest.current)
    pause.current = undefined
    longest.current = undefined
    if (!pending.current || done.current) return
    const { page: now, base: from, origin: came } = latest.current
    const draft: DraftIn = { title: now.title, text: now.text, tags: now.tags, cover: now.cover, ...(now.cover && now.cover_crop ? { cover_crop: now.cover_crop } : {}), base_revision: from, ...(came.by === 'ai' ? { written_by: 'ai' as const, ai_length: came.length } : {}) }
    const body = JSON.stringify(draft)
    pending.current = false
    if (body === sentDraft.current) return
    try {
      await diaryApi.saveDraft(date, draft, keepalive && body.length < KEEPALIVE_MAX)
      sentDraft.current = body
      setKept(true)
    } catch {
      // Tried again with the next change; the page still holds everything.
      pending.current = true
    }
  }
  /** For the timers and the listeners, which outlive a render. */
  const flushing = useRef(flush)
  useEffect(() => {
    flushing.current = flush
  })

  const changed = (asked: Partial<Page>) => {
    // Another cover begins without a cut.
    const next = 'cover' in asked && !('cover_crop' in asked) ? { ...asked, cover_crop: null } : asked
    for (const field of Object.keys(asked) as Field[]) touched.current.add(field)
    const merged = { ...latest.current.page, ...next }
    latest.current = { ...latest.current, page: merged }
    setPage(merged)
    setKept(false)
    pending.current = true
    window.clearTimeout(pause.current)
    pause.current = window.setTimeout(() => void flushing.current(), DRAFT_PAUSE_MS)
    if (longest.current === undefined) longest.current = window.setTimeout(() => void flushing.current(), DRAFT_LONGEST_MS)
  }

  useEffect(() => {
    const flush = (keepalive: boolean) => flushing.current(keepalive)
    const hidden = () => {
      if (document.visibilityState === 'hidden') void flush(true)
    }
    const leaving = (event: BeforeUnloadEvent) => {
      if (!pending.current || done.current) return
      const large = JSON.stringify(latest.current.page).length >= KEEPALIVE_MAX
      void flush(true)
      // A small draft goes out with the closing page (keepalive); a large one may not: the browser asks to stay.
      if (large) event.preventDefault()
    }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', hidden)
    window.addEventListener('beforeunload', leaving)
    return () => {
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('pagehide', hidden)
      window.removeEventListener('beforeunload', leaving)
      // Leaving within the app (a link, the back button): what was typed goes along. The page lives on, so an
      // ordinary request, which carries a draft of any size.
      void flush(false)
    }
  }, [])

  // --- Saving -------------------------------------------------------------------------------------------------------

  const finished = async () => {
    done.current = true
    pending.current = false
    let notice = t('write.savedPlain')
    if (isToday) {
      try {
        const streak = (await diaryApi.today()).streak
        if (streak > 0) notice = t('write.saved', { count: streak })
      } catch {
        // The plain word then.
      }
    }
    navigate(isToday ? '/' : '/tagebuch', { state: { notice } })
  }

  /** What a save sends: the fields changed here, the cover also while none was chosen on the server (a page is
   * never without one), and who wrote it for a new page. */
  const changeOf = (now: Page, against: DayPage | null, from: number) => {
    const change: DayChange = { base_revision: from }
    for (const field of touched.current) if (field !== 'cover' && field !== 'cover_crop') Object.assign(change, { [field]: now[field] })
    // The sections of the template that stayed empty fall away; the other headings and all that is written stay.
    if (sections && typeof change.text === 'string') change.text = withoutEmptySections(change.text, sections.map((section) => section.heading))
    if (touched.current.has('cover') || touched.current.has('cover_crop') || !against?.cover_chosen) {
      change.cover = now.cover ?? defaultCover(date, now.tags, dayPhotos, time)
      // Another cover starts without a cut on the server; the same one keeps its cut unless one is sent (none included).
      const crop = now.cover ? now.cover_crop : null
      if (change.cover.startsWith('photo:') && (crop || touched.current.has('cover_crop') || change.cover === against?.cover)) change.cover_crop = crop
    }
    // Begun from a suggestion of the AI: written with the AI, however much was changed after.
    if (latest.current.origin.by === 'ai') change.written_by = 'ai'
    else if (!against?.written_by) change.written_by = 'self'
    return change
  }

  const save = async (from = latest.current.base, against: DayPage | null = day) => {
    if (savingNow.current) return
    savingNow.current = true
    setSaving(true)
    setProblem(null)
    window.clearTimeout(pause.current)
    window.clearTimeout(longest.current)
    const now = settled()
    try {
      await diaryApi.changeDay(date, changeOf(now, against, from))
      await finished()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'day_changed') {
        const current = await orNull(diaryApi.day(date)).catch(() => null)
        const there = pageOf(current)
        const mine = [...touched.current]
        const from = started.current
        if (current && mine.every((field) => same(there[field], now[field]))) {
          // The first click went through, its answer was lost: saved.
          await finished()
          return
        }
        // Changed there and here: the same field, unless it is still as this writing found it.
        const clash = !current || from === null || mine.some((field) => !same(there[field], from[field]) && !same(there[field], now[field]))
        if (!clash) {
          // Only other fields changed meanwhile (a rating, tags on "Today"): they stay, this writing's go on top.
          savingNow.current = false
          started.current = { ...there, ...Object.fromEntries(mine.map((field) => [field, from![field]])) }
          setDay(current)
          setBase(current.revision)
          return save(current.revision, current)
        }
        setCopied(false)
        setConflict(current ?? { ...(day as DayPage), date, revision: -1, title: '', text: '', tags: [], cover: '', cover_chosen: false, cover_crop: null })
      } else setProblem(codeOf(error))
    } finally {
      savingNow.current = false
      setSaving(false)
    }
  }

  /** Saves this writing over the other version; what was not changed here stays as it is there. The other version
   * stood on the page to copy from until now. */
  const keepMine = () => {
    if (!conflict) return
    const other = conflict
    setConflict(null)
    setBase(other.revision)
    started.current = pageOf(other.revision >= 0 ? other : null)
    if (other.revision >= 0) setDay(other)
    // A page deleted elsewhere is a new page again: everything of this writing goes.
    if (other.revision < 0) for (const field of FIELDS) touched.current.add(field)
    void save(other.revision, other.revision >= 0 ? other : null)
  }

  const loadOther = () => {
    if (!conflict) return
    const other = pageOf(conflict.revision >= 0 ? conflict : null)
    setPage(other)
    setOrigin({ by: null, length: 'long' })
    latest.current = { page: other, base: conflict.revision, origin: { by: null, length: 'long' } }
    setBase(conflict.revision)
    setDay(conflict.revision >= 0 ? conflict : null)
    started.current = other
    touched.current = new Set()
    pending.current = false
    sentDraft.current = ''
    framePage(templateSet)
    setEditorKey((key) => key + 1)
    setConflict(null)
    void diaryApi.deleteDraft(date).catch(() => undefined)
  }

  const copyOther = async () => {
    if (!conflict) return
    if (await copyText([conflict.title, conflict.text].filter(Boolean).join('\n\n'))) setCopied(true)
  }

  const discardDraft = async () => {
    pending.current = false
    window.clearTimeout(pause.current)
    window.clearTimeout(longest.current)
    try {
      await diaryApi.deleteDraft(date)
    } catch {
      // Replaced by the next draft anyway.
    }
    setRestored(null)
    setAutoDraft(false)
    const server = pageOf(day)
    setPage(server)
    setOrigin({ by: null, length: 'long' })
    latest.current = { page: server, base: day?.revision ?? -1, origin: { by: null, length: 'long' } }
    started.current = server
    touched.current = new Set()
    setBase(day?.revision ?? -1)
    sentDraft.current = ''
    framePage(templateSet)
    setEditorKey((key) => key + 1)
  }

  const upload = async (file: File) => {
    setUploading(true)
    try {
      const photo = await uploadPhoto(file, date)
      setPhotos((current) => (current.some((item) => item.id === photo.id) ? current : [...current, photo]))
      changed({ cover: `photo:${photo.id}` })
      setPicking(false)
    } catch (error) {
      setProblem(codeOf(error))
    } finally {
      setUploading(false)
    }
  }

  /** A photo of Immich becomes a photo of this day (copied now); the picker makes it the cover. */
  const takeFromImmich = async (entry: ImmichPhoto): Promise<string | null> => {
    const photo = await immich.take(entry.id)
    if (!photo) return null
    setPhotos((current) => (current.some((item) => item.id === photo.id) ? current : [...current, photo]))
    return photo.id
  }

  /** The big view of the photos of the notes; a photo deleted there leaves the page's lists. */
  const viewNotePhotos = useOwnPhotoViewer((id) => {
    setPhotos((current) => current.filter((item) => item.id !== id))
    setNotes((current) => current.map((note) => (note.photo_id === id ? { ...note, photo_id: null } : note)))
    if (latest.current.page.cover === `photo:${id}`) changed({ cover: null })
  })

  const keepPhotoHere = (photo: Photo) => setPhotos((current) => (current.some((item) => item.id === photo.id) ? current : [...current, photo]))

  /** A photo from the device (camera or file) into the text, as a block of its own where the caret is. */
  const insertFromFile = async (file: File) => {
    setImaging(true)
    setProblem(null)
    try {
      // Made for the text: if the picture leaves the text again, the photo is not kept (the server tidies up on saving).
      const photo = await uploadPhoto(file, date, false, true)
      keepPhotoHere(photo)
      editor.current?.insertPhoto(photo.id)
    } catch (error) {
      setProblem(codeOf(error))
    } finally {
      setImaging(false)
    }
  }

  /** A photo of the whole collection of the own Immich into the text; it becomes a photo of this day. */
  const pickForText = async (entry: ImmichEntry) => {
    const photo = await immichApi.take(entry.id, date, false, true, true)
    keepPhotoHere(photo)
    editor.current?.insertPhoto(photo.id)
  }

  /** The same, as the cover of the day. */
  const pickForCover = async (entry: ImmichEntry) => {
    const photo = await immichApi.take(entry.id, date, false, true)
    keepPhotoHere(photo)
    changed({ cover: `photo:${photo.id}` })
  }

  const back = async () => {
    await flush()
    navigate(isToday ? '/' : '/tagebuch')
  }

  /** Deletes an own photo of the day (asked in the picker first); a cover it was falls back to the suggestion. */
  const removePhoto = async (photo: Photo) => {
    try {
      await photosApi.remove(photo.id)
      setPhotos((current) => current.filter((item) => item.id !== photo.id))
      setNotes((current) => current.map((note) => (note.photo_id === photo.id ? { ...note, photo_id: null } : note)))
      if (latest.current.page.cover === `photo:${photo.id}` || day?.cover === `photo:${photo.id}`) changed({ cover: null })
    } catch (error) {
      setProblem(codeOf(error))
    }
  }

  // --- The AI -------------------------------------------------------------------------------------------------------

  /** Asks the AI for a suggestion out of the notes of the day; it becomes the writing, title and text. */
  const formulate = async (length: AiLength) => {
    if (askingAi.current) return
    askingAi.current = true
    setFormulating(true)
    setProblem(null)
    try {
      const suggestion = await aiApi.formulate(date, length, templateParam)
      const from = { by: 'ai' as const, length }
      setOrigin(from)
      latest.current = { ...latest.current, origin: from }
      suggested.current = { title: suggestion.title, text: suggestion.text }
      changed({ title: suggestion.title, text: suggestion.text })
      setEditorKey((key) => key + 1)
    } catch (error) {
      setProblem(codeOf(error))
    } finally {
      askingAi.current = false
      setFormulating(false)
    }
  }

  // The press of "Ausformulieren" on "Today", taken once and forgotten at once: a reload of this page asks nothing.
  useEffect(() => {
    if (location.state && askedLength(location.state)) navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate])
  useEffect(() => {
    const length = wanted.current
    if (!loaded || !length) return
    wanted.current = null
    // Only onto an empty page at once; over a saved page, a draft or a suggestion only after asking.
    const now = latest.current.page
    if (isBlank(now)) void formulate(length)
    else setRedo({ length, over: day?.text.trim() ? 'page' : latest.current.origin.by === 'ai' ? 'suggestion' : 'draft' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  /** "Ausformulieren" here: onto an empty page at once, over a saved page or a draft only after asking. */
  const ask = (asked: AiLength) => {
    const now = latest.current.page
    if (isBlank(now)) void formulate(asked)
    else setRedo({ length: asked, over: day?.text.trim() ? 'page' : 'draft' })
  }

  /** "Länger"/"Kürzer": anew from the notes; over changes to the suggestion only when the person confirms. */
  const again = (length: AiLength) => {
    // The editor reports a change after a short pause in the typing; what it reported is what was changed.
    const now = latest.current.page
    const untouched = suggested.current !== null && now.text === suggested.current.text && now.title === suggested.current.title
    if (untouched || isBlank(now)) void formulate(length)
    else setRedo({ length, over: latest.current.origin.by === 'ai' ? 'suggestion' : 'draft' })
  }

  const aiOn = Boolean(ai?.available)
  // "Ausformulieren" above the text: a day with notes to write from and no saved page, before the AI wrote anything.
  const usableNotes = notes.some((note) => note.text && !note.unreadable)
  const offerAi = aiOn && loaded && !formulating && origin.by !== 'ai' && !day?.text.trim() && usableNotes && (isBlank(page) || restored !== null)
  // A saved page, for notes added later: "Neu ausformulieren" in the bar, asked before it writes over the page.
  const offerAnew = aiOn && loaded && origin.by !== 'ai' && Boolean(day?.text.trim()) && usableNotes

  // The line "Vorlage": only for a person with templates, and only while nothing of theirs is on the page yet.
  const showTemplates =
    loaded && !formulating && templates.length > 0 && !day?.text.trim() && untouchedText(page.text, templates) && (Boolean(tidy(page.text)) || !page.title.trim())

  // The title wraps on a narrow screen: the field grows with it, and its words never hold a line break.
  useLayoutEffect(() => {
    const field = titleField.current
    if (!field) return
    const fit = () => {
      field.style.height = 'auto'
      field.style.height = `${field.scrollHeight}px`
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [page.title, loaded, formulating])

  // From the editor itself, at once: the first letter on an empty page makes it savable.
  const canSave = loaded && !editorEmpty && !saving && !formulating && !day?.locked
  const unsaved = touched.current.size > 0 || restored !== null
  // A saved page can be locked; with changes not yet saved they would be left out, so those come first.
  const canLock = loaded && Boolean(day && (day.title.trim() || day.text.trim())) && !day?.locked

  // Ctrl+S and Cmd+S save, as everywhere; the browser's own "save page" does not open.
  const saveNow = useRef<() => void>(() => undefined)
  useEffect(() => {
    saveNow.current = () => {
      if (canSave) void save()
    }
  })
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (!event.repeat) saveNow.current()
      }
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [])

  // A locked day is not written on any more (the server refuses every change in any case).
  if (day?.locked)
    return (
      <div className="page pt-10 pb-28 lg:pb-12">
        <article className="card flex flex-col items-start gap-4 p-8">
          <LockedMark label className="text-sm font-semibold text-muted" />
          <p className="text-ink-2">{t('lock.readOnly')}</p>
          <Link to={`/tag/${date}`} className="inline-flex h-11 items-center rounded-full bg-accent-soft px-5 font-semibold text-accent hover:brightness-[0.98]">
            {t('lock.toDay')}
          </Link>
        </article>
      </div>
    )

  return (
    <div className="page grid grid-cols-1 gap-6 pt-6 pb-28 lg:grid-cols-[minmax(0,1fr)_320px] lg:pb-12">
      <div>
        <div className="sticky top-0 z-20 -mx-4 mb-4 bg-paper/95 px-4 pt-2.5 pb-1 backdrop-blur lg:mx-0 lg:px-0 lg:pt-3" data-write-bar>
        <div className="flex items-center justify-between gap-3 pb-2.5">
          <button type="button" onClick={() => void back()} className="text-sm font-semibold text-muted hover:text-ink">
            ← <span className="sm:hidden">{t('write.backShort')}</span>
            <span className="hidden sm:inline">{t('write.back')}</span>
          </button>
          <div className="flex items-center gap-2">
            {aiOn && origin.by === 'ai' && (
              <button
                type="button"
                onClick={() => again(origin.length === 'short' ? 'long' : 'short')}
                disabled={formulating}
                className="inline-flex h-8 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold text-ink-2 transition hover:bg-sheet-2 disabled:pointer-events-none disabled:opacity-50"
              >
                <Sparkles size={15} aria-hidden /> {origin.length === 'short' ? t('write.longer') : t('write.shorter')}
              </button>
            )}
            {offerAnew && (
              <button
                type="button"
                onClick={() => ask(length)}
                disabled={formulating}
                className="inline-flex h-8 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold text-ink-2 transition hover:bg-sheet-2 disabled:pointer-events-none disabled:opacity-50"
              >
                <Sparkles size={15} aria-hidden /> {t('write.aiAnew')}
              </button>
            )}
            {kept && (
              <span className="text-xs text-muted" role="status">
                {t('write.draftKept')}
              </span>
            )}
            {canLock && (
              <button
                type="button"
                onClick={() => setLocking(true)}
                aria-label={t('lock.action')}
                disabled={unsaved || saving}
                title={unsaved ? t('lock.saveFirst') : t('lock.action')}
                className="inline-flex h-8 items-center justify-center gap-2 rounded-full px-3 text-sm font-semibold text-ink-2 transition hover:bg-sheet-2 disabled:pointer-events-none disabled:opacity-50"
              >
                <Lock size={15} aria-hidden /> <span className="hidden sm:inline" aria-hidden>{t('lock.action')}</span>
              </button>
            )}
            <SaveButton className="hidden h-8 px-3.5 text-sm lg:inline-flex" onSave={() => void save()} disabled={!canSave} saving={saving} />
          </div>
        </div>
        <div ref={setToolbarHost} />
        </div>
        {restored && autoDraft && (
          <Notice>
            <span className="block font-semibold">{t('autowrite.waiting')}</span>
            <span className="mt-1 block text-ink-2">{t('autowrite.waitingText')}</span>
            <span className="mt-3 flex flex-wrap gap-2" data-auto-draft>
              <button type="button" onClick={() => void save()} disabled={!canSave} className="inline-flex h-8 items-center rounded-full bg-accent px-3.5 text-sm font-semibold text-accent-ink disabled:opacity-50">
                {t('autowrite.accept')}
              </button>
              <button type="button" onClick={() => void discardDraft()} className="inline-flex h-8 items-center rounded-full px-3.5 text-sm font-semibold text-ink-2 hover:bg-sheet-2">
                {t('autowrite.discard')}
              </button>
            </span>
          </Notice>
        )}
        {restored && !autoDraft && (
          <Notice>
            {t('write.draftBack', { time: restored })}{' '}
            <button type="button" onClick={() => void discardDraft()} className="font-semibold text-accent underline-offset-2 hover:underline">
              {t('write.discardDraft')}
            </button>
          </Notice>
        )}
        {conflict && (
          <Notice tone="warn">
            <span className="block">{t('write.conflict')}</span>
            <span className="mt-1 block text-ink-2">{t('write.conflictHint')}</span>
            {(conflict.title || conflict.text) && (
              <span className="mt-3 block rounded-lg border border-line bg-sheet p-3">
                <span className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-xs font-bold tracking-wide text-muted uppercase">{t('write.otherVersion')}</span>
                  <button type="button" onClick={() => void copyOther()} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold text-accent hover:bg-sheet-2">
                    {copied ? t('common.copied') : t('common.copy')}
                  </button>
                </span>
                <span data-other-version className="block max-h-48 overflow-auto font-serif text-sm whitespace-pre-wrap text-ink">
                  {[conflict.title, conflict.text].filter(Boolean).join('\n\n')}
                </span>
              </span>
            )}
            <span className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={keepMine} className="inline-flex h-8 items-center rounded-full bg-accent px-3.5 text-sm font-semibold text-accent-ink">
                {t('write.keepMine')}
              </button>
              <button type="button" onClick={loadOther} className="inline-flex h-8 items-center rounded-full px-3.5 text-sm font-semibold text-ink-2 hover:bg-sheet-2">
                {t('write.loadOther')}
              </button>
            </span>
          </Notice>
        )}
        {problem && (
          <p role="alert" className="mb-4 rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
            {errorText(problem.code, problem.values)}
          </p>
        )}
        <article className="card px-6 py-8 sm:px-10">
          <p className="mb-2 text-sm font-semibold tracking-wide text-muted uppercase">{date ? longDate(date, i18n.language, true) : ''}</p>
          {!loaded ? (
            <p className="py-6 text-sm text-muted">{problem ? '' : t('write.loading')}</p>
          ) : formulating ? (
            <div className="space-y-3 py-2" role="status">
              <div className="shimmer h-9 w-2/3 rounded-lg" />
              {[100, 94, 98, 70, 96, 88].map((width, index) => (
                <div key={index} className="shimmer h-4 rounded" style={{ width: `${width}%` }} />
              ))}
              <p className="pt-3 text-sm text-muted">
                <Sparkles size={14} className="mr-1 inline" aria-hidden /> {t('write.aiLoading')}
              </p>
            </div>
          ) : (
            <>
              {offerAi && ai && (
                <div className="mb-6 space-y-2 rounded-2xl bg-accent-soft/50 p-4" data-offer-ai>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => ask(length)}
                      className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-accent px-5 text-[0.95rem] font-semibold text-accent-ink shadow-soft transition hover:brightness-105"
                    >
                      <Sparkles size={18} aria-hidden /> {t('write.ai')}
                    </button>
                    <div role="radiogroup" aria-label={t('write.length')} className="flex rounded-full bg-sheet-2 p-1 text-sm font-semibold">
                      {(['short', 'long'] as const).map((value) => (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={length === value}
                          onClick={() => setLength(value)}
                          className={`rounded-full px-3 ${length === value ? 'bg-sheet text-ink shadow-sm' : 'text-muted'}`}
                        >
                          {value === 'short' ? t('write.lengthShort') : t('write.lengthLong')}
                        </button>
                      ))}
                    </div>
                  </div>
                  <p className="text-xs leading-relaxed text-muted">
                    {aiHint(ai, t)} {t('write.aiPromise')}
                  </p>
                </div>
              )}
              <textarea
                ref={titleField}
                rows={1}
                value={page.title}
                maxLength={200}
                onChange={(e) => changed({ title: e.target.value.replace(/[\r\n]+/g, ' ') })}
                onKeyDown={(e) => {
                  // A title is one line: Enter goes on to the text.
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    editor.current?.focus()
                  }
                }}
                placeholder={t('write.titlePlaceholder')}
                aria-label={t('write.titleLabel')}
                className="mb-5 block w-full resize-none overflow-hidden bg-transparent font-display text-3xl leading-tight font-semibold tracking-tight text-ink placeholder:text-muted/60 focus:outline-none sm:text-4xl"
              />
              <div className="relative mb-6 overflow-hidden rounded-2xl">
                <CoverImage cover={shownCover} crop={page.cover ? page.cover_crop : null} large className="aspect-[16/8] w-full" alt={t('write.coverLabel')} />
                <span className="absolute right-3 bottom-3 flex gap-2">
                  {coverPhoto && (
                    <button type="button" onClick={() => setCropping(true)} className="inline-flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur hover:bg-black/60" data-cover-crop-open>
                      <Crop size={14} aria-hidden /> {t('cover.crop.short')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setPicking(true)}
                    className="inline-flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur hover:bg-black/60"
                  >
                    <ImageIcon size={14} aria-hidden /> {t('write.changeCover')}
                  </button>
                </span>
              </div>
              {showTemplates && (
                <div className="mb-4" data-template-row>
                  <label className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="font-semibold text-ink-2">{t('write.template')}</span>
                    <select
                      value={chosenTemplate?.id ?? ''}
                      onChange={(event) => pickTemplate(event.target.value)}
                      className="h-9 max-w-full min-w-0 rounded-xl border border-line bg-sheet px-3 text-ink"
                    >
                      <option value="">{t('write.templateNone')}</option>
                      {templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {chosenTemplate && <p className="mt-1.5 text-xs text-muted">{t('write.templateHint')}</p>}
                </div>
              )}
              <DiaryEditor
                key={editorKey}
                ref={editor}
                value={page.text}
                onChange={(text) => {
                  if (!sameText(text, latest.current.page.text)) changed({ text })
                }}
                onEmptyChange={setEditorEmpty}
                toolbarHost={toolbarHost}
                images={{
                  busy: imaging,
                  onFile: (file) => void insertFromFile(file),
                  onImmich: immichReady ? () => setChooser('text') : undefined,
                  onDay: photos.length > 0 ? () => setChooser('day') : undefined,
                }}
                sections={sections}
                placeholder={t('write.bodyPlaceholder')}
                label={t('write.bodyLabel')}
              />
              {origin.by === 'ai' && (
                <p className="mt-6 rounded-xl bg-sheet-2 px-4 py-3 text-sm text-ink-2">
                  <Sparkles size={14} className="mr-1 inline text-accent" aria-hidden />
                  {t('write.aiSuggestion')}
                </p>
              )}
            </>
          )}
        </article>
      </div>
      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        {loaded && !formulating && <WritePrompts date={date} onInsert={(question) => editor.current?.insertHeading(question)} />}
        {loaded && (
          <section className="card p-5">
            <h2 className="mb-3 font-display text-lg font-semibold">{t('today.tags')}</h2>
            <TagPicker tags={page.tags} onChange={(tags) => changed({ tags })} />
          </section>
        )}
        <section className="card p-5">
          <h2 className="mb-3 font-display text-lg font-semibold">{t('write.yourNotes')}</h2>
          {notes.some((note) => note.photo_id) && <p className="-mt-1 mb-3 text-xs text-muted">{t('write.noteInsertHint')}</p>}
          {notes.length === 0 ? (
            <p className="text-sm text-muted">{t('write.noNotes')}</p>
          ) : (
            <ul className="space-y-2.5">
              {notes.map((note) => (
                <li key={note.id} className="flex gap-3 text-sm">
                  <span className="w-10 shrink-0 font-bold text-muted tabular-nums">{timeOf(note.created_at, zone)}</span>
                  <span className="min-w-0 text-ink-2">
                    {note.prompt && <span className="block font-serif text-accent italic">{note.prompt}</span>}
                    {note.text}
                    {note.photo_id && (
                      <span className="relative mt-1.5 block w-24">
                        <button
                          type="button"
                          onClick={() => editor.current?.insertPhoto(note.photo_id as string)}
                          disabled={!loaded || formulating}
                          title={t('write.noteInsert')}
                          aria-label={t('write.noteInsert')}
                          className="block overflow-hidden rounded-lg ring-accent transition hover:ring-2 focus-visible:ring-2 disabled:opacity-50"
                        >
                          <img src={photoUrl(note.photo_id, true)} alt={t('photos.alt')} className="h-16 w-24 object-cover object-center" draggable={false} />
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            const withPhotos = notes.filter((item) => item.photo_id)
                            viewNotePhotos(withPhotos.map((item) => ({ id: item.photo_id as string })), Math.max(0, withPhotos.findIndex((item) => item.id === note.id)), event.currentTarget)
                          }}
                          className="absolute right-1 bottom-1 rounded-full bg-black/55 p-1 text-white hover:bg-black/70"
                          aria-label={t('photoView.open')}
                        >
                          <ZoomIn size={13} aria-hidden />
                        </button>
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      {/* On a phone: "Save" always in reach, above the keyboard. */}
      <div className="fixed inset-x-0 z-30 border-t border-line bg-sheet/95 px-4 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur lg:hidden" style={{ bottom: inset }}>
        <SaveButton className="h-11 w-full px-5 text-[0.95rem]" onSave={() => void save()} disabled={!canSave} saving={saving} />
      </div>

      {redo && (
        <Dialog title={t(REDO[redo.over].title)} onClose={() => setRedo(null)}>
          <p className="text-sm text-ink-2">{t(REDO[redo.over].text)}</p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setRedo(null)} className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-semibold text-ink-2 hover:bg-sheet-2">
              {t(REDO[redo.over].keep)}
            </button>
            <button
              type="button"
              onClick={() => {
                const asked = redo.length
                setRedo(null)
                void formulate(asked)
              }}
              className="inline-flex h-10 items-center rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink hover:brightness-105"
            >
              {t(REDO[redo.over].go)}
            </button>
          </div>
        </Dialog>
      )}

      {locking && (
        <LockDialog
          date={date}
          onClose={() => setLocking(false)}
          onLocked={() => {
            // Nothing is left to send: the server ended the draft with the lock.
            done.current = true
            pending.current = false
            navigate(`/tag/${date}`, { state: { notice: t('lock.done') } })
          }}
        />
      )}

      {picking && (
        <CoverPicker
          date={date}
          tags={page.tags}
          photos={photos}
          value={shownCover}
          time={time}
          onChange={(cover) => changed({ cover })}
          onClose={() => setPicking(false)}
          onUpload={(file) => void upload(file)}
          onDelete={removePhoto}
          uploading={uploading}
          immich={(immich.photos ?? []).filter((entry) => !entry.photo_id || !photos.some((photo) => photo.id === entry.photo_id))}
          taking={immich.taking}
          problem={immich.problem}
          onImmich={takeFromImmich}
          onMoreImmich={
            immichReady
              ? () => {
                  setPicking(false)
                  setChooser('cover')
                }
              : undefined
          }
          onCrop={() => {
            setPicking(false)
            setCropping(true)
          }}
        />
      )}

      {cropping && coverPhoto && (
        <CoverCropDialog
          src={photoUrl(coverPhoto.id, true)}
          value={page.cover ? page.cover_crop : null}
          width={coverPhoto.width}
          height={coverPhoto.height}
          onClose={() => setCropping(false)}
          // The cover shown (the suggestion too) becomes the chosen one, with its cut.
          onDone={(crop) => {
            setCropping(false)
            changed({ cover: shownCover, cover_crop: crop })
          }}
        />
      )}

      {chooser === 'text' && <ImmichPicker date={date} onClose={() => setChooser(null)} onPick={pickForText} />}
      {chooser === 'cover' && <ImmichPicker date={date} onClose={() => setChooser(null)} onPick={pickForCover} />}
      {chooser === 'day' && <DayPhotoPicker photos={photos} onPick={(photo) => editor.current?.insertPhoto(photo.id)} onClose={() => setChooser(null)} />}
    </div>
  )
}

/** "Weiterschreiben?", as the mock: four questions at a time to put in as a subheading at the end, more on a tap. */
function WritePrompts({ date, onInsert }: { date: string; onInsert: (question: string) => void }) {
  const { t } = useTranslation()
  const [pool, setPool] = useState<Question[]>([])
  // As the mock: the question of the day stood on "Today" already; the writing begins two further on.
  const [start, setStart] = useState(2)
  useEffect(() => {
    let alive = true
    promptsApi.pool(date).then(
      (found) => alive && setPool(Array.isArray(found?.questions) ? found.questions : []),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [date])
  if (pool.length === 0) return null
  const shown = Array.from({ length: Math.min(4, pool.length) }, (_, index) => pool[(start + index) % pool.length])
  return (
    <section className="card p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold">{t('write.morePrompts')}</h2>
        <button type="button" onClick={() => setStart(start + 4)} className="rounded-full p-1.5 text-muted hover:bg-sheet-2 hover:text-ink" aria-label={t('write.otherPrompts')}>
          <Shuffle size={15} />
        </button>
      </div>
      <p className="mb-3 text-xs text-muted">{t('write.morePromptsHint')}</p>
      <ul className="space-y-1.5">
        {shown.map((question) => (
          <li key={question.id}>
            <button type="button" onClick={() => onInsert(question.text)} className="w-full rounded-xl bg-sheet-2/70 px-3 py-2 text-left font-serif text-sm text-ink-2 hover:bg-accent-soft hover:text-ink">
              {question.text}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function SaveButton({ className, onSave, disabled, saving }: { className: string; onSave: () => void; disabled: boolean; saving: boolean }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onSave}
      disabled={disabled}
      className={`items-center justify-center gap-2 rounded-full bg-accent font-semibold text-accent-ink shadow-soft transition hover:brightness-105 disabled:pointer-events-none disabled:opacity-50 ${className.includes('hidden') ? '' : 'inline-flex'} ${className}`}
    >
      {saving ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Check size={15} aria-hidden />} {saving ? t('write.saving') : t('write.save')}
    </button>
  )
}

function Notice({ children, tone = 'calm' }: { children: ReactNode; tone?: 'calm' | 'warn' }) {
  return (
    <div role="status" className={`mb-4 rounded-xl px-4 py-3 text-sm ${tone === 'warn' ? 'border border-warn/40 bg-warn/10 text-ink' : 'bg-sheet-2 text-ink-2'}`}>
      {children}
    </div>
  )
}
