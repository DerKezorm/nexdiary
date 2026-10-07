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
 * On a phone "Save" stays at the bottom, above the keyboard; the menu bar of the app is not shown while writing.
 * Loaded only when somebody writes: the editor is the heaviest part of the app.
 */
import { Check, ImageIcon, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'

import { ApiError, diaryApi, photosApi, photoUrl, type DayChange, type DayPage, type DraftIn, type Note, type Photo } from '../api/client'
import { TagPicker } from '../components/TagPicker'
import { CoverImage, CoverPicker, defaultCover } from '../covers/Cover'
import { timeOfHour, type Time } from '../covers/suggest'
import { DiaryEditor, type DiaryEditorHandle } from '../editor/DiaryEditor'
import { copyText } from '../lib/copy'
import { longDate, timeOf } from '../lib/dates'
import { errorText } from '../lib/errors'
import { uploadPhoto } from '../lib/upload'
import { useAuth } from '../state/auth'

/** After the last key, how long until the draft goes out; and the longest it waits while somebody types on. */
const DRAFT_PAUSE_MS = 1500
const DRAFT_LONGEST_MS = 8000

type Problem = { code: string; values?: Record<string, unknown> }
type Page = { title: string; text: string; tags: string[]; cover: string | null }
type Field = keyof Page
const FIELDS: Field[] = ['title', 'text', 'tags', 'cover']
/** keepalive carries at most 64 KB per page; a larger draft goes out as an ordinary request and the page warns. */
const KEEPALIVE_MAX = 60_000
const EMPTY: Page = { title: '', text: '', tags: [], cover: null }

/** The page as the server holds it, with the cover only when one was chosen. */
function pageOf(day: DayPage | null): Page {
  return day ? { title: day.title, text: day.text, tags: day.tags, cover: day.cover_chosen ? day.cover : null } : EMPTY
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
  const zone = me?.profile?.timezone
  const [today] = useState(() => nowIn(zone))
  const isToday = date === today.date
  const time: Time = isToday ? timeOfHour(today.hour) : 'abend'

  const [loaded, setLoaded] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [day, setDay] = useState<DayPage | null>(null)
  const [notes, setNotes] = useState<Note[]>([])
  const [photos, setPhotos] = useState<Photo[]>([])
  const [page, setPage] = useState<Page>({ title: '', text: '', tags: [], cover: null })
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
  const [uploading, setUploading] = useState(false)
  const inset = useKeyboardInset()
  const editor = useRef<DiaryEditorHandle>(null)

  /** What the page holds right now, for the timers and handlers that outlive a render. */
  const latest = useRef({ page, base })
  useEffect(() => {
    latest.current = { page, base }
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

  // --- Loading ------------------------------------------------------------------------------------------------------

  useEffect(() => {
    let gone = false
    void (async () => {
      try {
        const [found, dayNotes, dayPhotos, draft] = await Promise.all([orNull(diaryApi.day(date)), diaryApi.notes(date), photosApi.list(date), diaryApi.draft(date)])
        if (gone) return
        setDay(found)
        setNotes(dayNotes)
        setPhotos(dayPhotos)
        const server = pageOf(found)
        // A draft is writing that was never saved (a save ends it): it comes back, and names where it started.
        if (draft) {
          const kept: Page = { title: draft.title, text: draft.text, tags: draft.tags, cover: draft.cover }
          setPage(kept)
          latest.current = { page: kept, base: draft.base_revision }
          setBase(draft.base_revision)
          // What the draft holds differently from the page it started from was written here.
          started.current = draft.base_revision === (found?.revision ?? -1) ? server : null
          touched.current = new Set(FIELDS.filter((field) => !same(kept[field], (started.current ?? server)[field]) || started.current === null))
          sentDraft.current = JSON.stringify({ ...kept, base_revision: draft.base_revision })
          setRestored(timeOf(draft.updated_at, zone))
        } else {
          setPage(server)
          latest.current = { page: server, base: found?.revision ?? -1 }
          setBase(found?.revision ?? -1)
          started.current = server
          touched.current = new Set()
        }
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
    const text = editor.current?.getMarkdown()
    if (text != null && text !== latest.current.page.text.replace(/\s+$/, '')) {
      const page = { ...latest.current.page, text }
      latest.current = { ...latest.current, page }
      pending.current = true
      touched.current.add('text')
      setPage(page)
    }
    return latest.current.page
  }

  const flush = async (keepalive = false) => {
    settled()
    window.clearTimeout(pause.current)
    window.clearTimeout(longest.current)
    pause.current = undefined
    longest.current = undefined
    if (!pending.current || done.current) return
    const { page: now, base: from } = latest.current
    const draft: DraftIn = { title: now.title, text: now.text, tags: now.tags, cover: now.cover, base_revision: from }
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

  const changed = (next: Partial<Page>) => {
    for (const field of Object.keys(next) as Field[]) touched.current.add(field)
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
    for (const field of touched.current) if (field !== 'cover') Object.assign(change, { [field]: now[field] })
    if (touched.current.has('cover') || !against?.cover_chosen) change.cover = now.cover ?? defaultCover(date, now.tags, dayPhotos, time)
    if (!against?.written_by) change.written_by = 'self'
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
        setConflict(current ?? { ...(day as DayPage), date, revision: -1, title: '', text: '', tags: [], cover: '', cover_chosen: false })
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
    latest.current = { page: other, base: conflict.revision }
    setBase(conflict.revision)
    setDay(conflict.revision >= 0 ? conflict : null)
    started.current = other
    touched.current = new Set()
    pending.current = false
    sentDraft.current = ''
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
    const server = pageOf(day)
    setPage(server)
    latest.current = { page: server, base: day?.revision ?? -1 }
    started.current = server
    touched.current = new Set()
    setBase(day?.revision ?? -1)
    sentDraft.current = ''
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

  // From the editor itself, at once: the first letter on an empty page makes it savable.
  const canSave = loaded && !editorEmpty && !saving

  return (
    <div className="page grid grid-cols-1 gap-6 pt-6 pb-28 lg:grid-cols-[minmax(0,1fr)_320px] lg:pb-12">
      <div>
        <div className="sticky top-0 z-20 -mx-4 mb-4 flex items-center justify-between gap-3 bg-paper/95 px-4 py-2.5 backdrop-blur lg:static lg:mx-0 lg:mb-5 lg:bg-transparent lg:px-0 lg:py-0 lg:backdrop-blur-none">
          <button type="button" onClick={() => void back()} className="text-sm font-semibold text-muted hover:text-ink">
            ← <span className="sm:hidden">{t('write.backShort')}</span>
            <span className="hidden sm:inline">{t('write.back')}</span>
          </button>
          <div className="flex items-center gap-2">
            {kept && (
              <span className="text-xs text-muted" role="status">
                {t('write.draftKept')}
              </span>
            )}
            <SaveButton className="hidden h-8 px-3.5 text-sm lg:inline-flex" onSave={() => void save()} disabled={!canSave} saving={saving} />
          </div>
        </div>
        {restored && (
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
          ) : (
            <>
              <input
                value={page.title}
                maxLength={200}
                onChange={(e) => changed({ title: e.target.value })}
                placeholder={t('write.titlePlaceholder')}
                aria-label={t('write.titleLabel')}
                className="mb-5 w-full bg-transparent font-display text-3xl font-semibold tracking-tight text-ink placeholder:text-muted/60 focus:outline-none sm:text-4xl"
              />
              <div className="relative mb-6 overflow-hidden rounded-2xl">
                <CoverImage cover={shownCover} large className="aspect-[16/8] w-full" alt={t('write.coverLabel')} />
                <button
                  type="button"
                  onClick={() => setPicking(true)}
                  className="absolute right-3 bottom-3 inline-flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur hover:bg-black/60"
                >
                  <ImageIcon size={14} aria-hidden /> {t('write.changeCover')}
                </button>
              </div>
              <DiaryEditor
                key={editorKey}
                ref={editor}
                value={page.text}
                onChange={(text) => {
                  if (text !== latest.current.page.text) changed({ text })
                }}
                onEmptyChange={setEditorEmpty}
                placeholder={t('write.bodyPlaceholder')}
                label={t('write.bodyLabel')}
              />
            </>
          )}
        </article>
      </div>
      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        {/* The writing prompts ("Weiterschreiben?") come here with the questions; `editor.current.insertHeading`. */}
        {loaded && (
          <section className="card p-5">
            <h2 className="mb-3 font-display text-lg font-semibold">{t('today.tags')}</h2>
            <TagPicker tags={page.tags} onChange={(tags) => changed({ tags })} />
          </section>
        )}
        <section className="card p-5">
          <h2 className="mb-3 font-display text-lg font-semibold">{t('write.yourNotes')}</h2>
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
                    {note.photo_id && <img src={photoUrl(note.photo_id, true)} alt={t('photos.alt')} className="mt-1.5 h-16 w-24 rounded-lg object-cover" />}
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
        />
      )}
    </div>
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
