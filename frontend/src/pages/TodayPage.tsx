/**
 * "Today", as the mock's `Today.tsx`, in the three layouts a person chooses under Settings, Look: one page, two columns,
 * or like a chat. Notes are thrown down here, changed and deleted; the values of the day are rated.
 *
 * Photos are taken or picked with the camera button beside the field (they go with the next note) and under "Fotos
 * von heute"; "Den Tag aufschreiben" leads to the writing page. What comes with later blocks has its place already and
 * stays empty until then: the question of the day (`PromptSlot`) and the photos from Immich.
 */
import { ArrowUp, Camera, Flame, ImagePlus, Loader2, PenLine, Trash2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'

import { photoUrl, type Note, type TodayData, type ValueDef } from '../api/client'
import { Dialog } from '../components/Dialog'
import { Scale } from '../components/Scale'
import { TagPicker } from '../components/TagPicker'
import { longDate, timeOf } from '../lib/dates'
import { errorText } from '../lib/errors'
import { PHOTO_ACCEPT } from '../lib/upload'
import { PendingPhoto, usePendingPhoto } from '../components/PendingPhoto'
import { useAuth } from '../state/auth'
import { useToday, type TodayState } from '../state/today'

/** Morning until eleven, the day until six, then the evening: the greeting of "Today". */
// eslint-disable-next-line react-refresh/only-export-components
export function greetingOf(hour: number): 'morning' | 'day' | 'evening' {
  return hour < 11 ? 'morning' : hour < 18 ? 'day' : 'evening'
}

export function TodayPage({ now }: { now?: Date }) {
  const today = useToday()
  const { me } = useAuth()
  const [drawer, setDrawer] = useState(false)
  const { t } = useTranslation()
  const layout = me?.profile?.layout ?? 'page'
  const problem = today.problem && <Problem code={today.problem} values={today.problemValues} />
  const [params] = useSearchParams()
  const toFinish = params.get('aufschreiben') === '1'
  const ready = Boolean(today.data)
  // From the quick note ("Den Tag aufschreiben"): straight to where the day is written up.
  useEffect(() => {
    if (!toFinish || !ready) return
    const timer = window.setTimeout(() => document.getElementById('aufschreiben')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100)
    return () => window.clearTimeout(timer)
  }, [toFinish, ready])

  if (!today.data)
    return (
      <div className="page pb-28 lg:pb-12">
        <Header now={now} today={today} />
        {problem}
      </div>
    )

  if (layout === 'chat')
    return (
      <div className="page flex min-h-[calc(100dvh-5rem)] flex-col lg:min-h-dvh">
        <Header now={now} today={today} onDay={() => setDrawer(true)} />
        <div className="mb-3">
          <FinishCard today={today} />
        </div>
        <div className="flex-1 pb-4">
          <Bubbles today={today} />
          <PromptSlot />
        </div>
        <div className="sticky bottom-[4.5rem] z-20 bg-gradient-to-t from-paper via-paper to-transparent pt-6 pb-3 lg:bottom-0">
          {problem}
          <Capture today={today} chat />
        </div>
        {drawer && (
          <Dialog title={t('today.yourDay')} onClose={() => setDrawer(false)}>
            <div className="space-y-6">
              <ValuesBlock today={today} bare />
              <PhotosBlock today={today} bare />
              <TagsBlock today={today} bare />
            </div>
          </Dialog>
        )}
      </div>
    )

  if (layout === 'columns')
    return (
      <div className="page pb-28 lg:pb-12">
        <Header now={now} today={today} />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-4">
            <Capture today={today} />
            {problem}
            <PromptSlot />
            <Timeline today={today} />
          </div>
          <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <FinishCard today={today} />
            <ValuesBlock today={today} />
            <PhotosBlock today={today} />
            <TagsBlock today={today} />
          </aside>
        </div>
      </div>
    )

  return (
    <div className="page space-y-5 pb-28 lg:pb-12">
      <Header now={now} today={today} />
      <Capture today={today} />
      {problem}
      <PromptSlot />
      <Timeline today={today} />
      <PhotosBlock today={today} />
      <ValuesBlock today={today} />
      <TagsBlock today={today} />
      <FinishCard today={today} />
    </div>
  )
}

/** The question of the day: comes with the writing prompts. */
function PromptSlot() {
  return null
}

/** "Den Tag aufschreiben", as the mock's finish card. The button "Ausformulieren" of the assistant comes here before
 * "Selbst schreiben" with the AI; a day that has a page already is written on ("Weiterschreiben"). */
function FinishCard({ today }: { today: TodayState }) {
  const { t } = useTranslation()
  const data = today.data as TodayData
  const count = data.notes.length
  const written = Boolean(data.day?.text.trim())
  const text = written ? t('write.finishExisting') : count > 0 ? t('write.finishText', { count }) : t('write.finishNoNotes')
  return (
    <section id="aufschreiben" className="card scroll-mt-6 overflow-hidden">
      <div className="bg-accent-soft/70 px-5 pt-5 pb-4">
        <h2 className="font-display text-lg font-semibold">{t('write.finishTitle')}</h2>
        <p className="mt-1 text-sm text-ink-2">{text}</p>
      </div>
      <div className="space-y-3 p-5">
        <Link
          to={`/tag/${data.date}/schreiben`}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-accent px-5 text-[0.95rem] font-semibold text-accent-ink shadow-soft transition hover:brightness-105"
        >
          <PenLine size={18} aria-hidden /> {written ? t('write.continue') : t('write.self')}
        </Link>
      </div>
    </section>
  )
}

/** The photos of today, as the mock's photo strip: the own uploads, each with its time, and a tile to add one. The
 * photos from Immich join them in their block. */
function PhotosBlock({ today, bare = false }: { today: TodayState; bare?: boolean }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  // The photos of the day itself; a photo that came with a note stands with its note.
  const onNotes = new Set((today.data?.notes ?? []).map((note) => note.photo_id).filter(Boolean))
  const photos = (today.data?.photos ?? []).filter((photo) => !onNotes.has(photo.id))
  const add = async (picked: File) => {
    setBusy(true)
    await today.addPhoto(picked)
    setBusy(false)
  }
  return (
    <Block title={t('photos.title')} bare={bare} extra={<span className="text-sm text-muted">{t('photos.count', { count: photos.length })}</span>}>
      <div className="scroll-x -mx-1 flex gap-2.5 overflow-x-auto px-1 pb-1">
        {photos.map((photo) => (
          <div key={photo.id} className="group relative shrink-0 overflow-hidden rounded-xl">
            <img src={photoUrl(photo.id, true)} alt={t('photos.alt')} className="h-24 w-32 object-cover" draggable={false} />
            <span className="absolute bottom-1 left-1.5 rounded bg-black/35 px-1 text-[0.68rem] font-bold text-white">{timeOf(photo.created_at, me?.profile?.timezone)}</span>
            <button
              type="button"
              onClick={() => void today.deletePhoto(photo.id)}
              className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-black/35 text-white opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
              aria-label={t('photos.delete')}
            >
              <X size={13} strokeWidth={3} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => file.current?.click()}
          disabled={busy}
          className="flex h-24 w-32 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line text-sm font-semibold text-muted hover:border-accent hover:text-accent disabled:opacity-60"
        >
          {busy ? <Loader2 size={20} className="animate-spin" aria-hidden /> : <ImagePlus size={20} aria-hidden />}
          {busy ? t('photos.uploading') : t('photos.upload')}
        </button>
        <input
          ref={file}
          type="file"
          accept={PHOTO_ACCEPT}
          className="hidden"
          aria-label={t('photos.upload')}
          onChange={(e) => {
            const picked = e.target.files?.[0]
            e.target.value = ''
            if (picked) void add(picked)
          }}
        />
      </div>
    </Block>
  )
}

function Problem({ code, values }: { code: string; values?: Record<string, unknown> }) {
  return (
    <p role="alert" className="rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
      {errorText(code, values)}
    </p>
  )
}

function Header({ now, today, onDay }: { now?: Date; today: TodayState; onDay?: () => void }) {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const moment = now ?? new Date()
  const date = today.data?.date
  const name = me?.display_name || me?.name || ''
  return (
    <header className="flex items-end justify-between gap-4 pt-8 pb-6">
      <div>
        <p className="text-sm font-semibold tracking-wide text-muted uppercase">
          {date ? longDate(date, i18n.language) : new Intl.DateTimeFormat(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' }).format(moment)}
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t(`today.greeting.${greetingOf(moment.getHours())}`, { name })}</h1>
      </div>
      <div className="flex items-center gap-2">
        {onDay && (
          <button type="button" onClick={onDay} className="inline-flex h-8 items-center justify-center gap-2 rounded-full bg-accent-soft px-3.5 text-sm font-semibold text-accent transition hover:brightness-[0.98]">
            {t('today.yourDay')}
          </button>
        )}
        {today.data && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 text-sm font-bold text-accent" title={t('today.streak')}>
            <Flame size={16} aria-hidden /> <span className="sr-only">{t('today.streak')}: </span>
            {today.data.streak}
          </span>
        )}
      </div>
    </header>
  )
}

function Capture({ today, chat = false }: { today: TodayState; chat?: boolean }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const pending = usePendingPhoto(today)
  const add = async () => {
    if (!text.trim() && !pending.photo) return
    if (await today.addNote(text, pending.photo?.id ?? null)) {
      setText('')
      pending.sent()
    }
    field.current?.focus()
  }
  return (
    <div className={`card p-2 ${chat ? 'rounded-[1.6rem]' : ''}`}>
      <PendingPhoto photo={pending.photo} busy={pending.busy} onDrop={pending.drop} />
      <div className="flex items-end gap-2">
      <button type="button" onClick={() => file.current?.click()} disabled={pending.busy} className="rounded-full p-2.5 text-muted hover:bg-sheet-2 hover:text-accent" title={t('photos.alt')} aria-label={t('photos.attach')}>
        <Camera size={20} />
      </button>
      <input
        ref={file}
        type="file"
        accept={PHOTO_ACCEPT}
        className="hidden"
        aria-label={t('photos.attach')}
        onChange={(e) => {
          const picked = e.target.files?.[0]
          e.target.value = ''
          if (picked) void pending.pick(picked)
        }}
      />
      <textarea
        ref={field}
        value={text}
        rows={chat ? 1 : 2}
        maxLength={5000}
        aria-label={t('today.capture')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void add()
          }
        }}
        placeholder={t('today.capture')}
        className="max-h-40 min-h-11 flex-1 resize-none bg-transparent px-1 py-2.5 text-[1.02rem] text-ink placeholder:text-muted focus:outline-none"
      />
      <button type="button" onClick={() => void add()} disabled={!text.trim() && !pending.photo} className="rounded-full bg-accent p-2.5 text-accent-ink transition disabled:opacity-30" aria-label={t('today.add')}>
        <ArrowUp size={20} />
      </button>
      </div>
    </div>
  )
}

function Timeline({ today }: { today: TodayState }) {
  const { t } = useTranslation()
  const notes = today.data?.notes ?? []
  return (
    <section className="card p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-lg font-semibold">{t('today.noted')}</h2>
        <span className="text-sm text-muted">{t('today.notes', { count: notes.length })}</span>
      </div>
      {notes.length === 0 ? (
        <p className="py-2 text-sm text-muted">{t('today.nothingYet')}</p>
      ) : (
        <ol className="relative space-y-1 before:absolute before:top-2 before:bottom-2 before:left-[3.15rem] before:w-px before:bg-line">
          {notes.map((note) => (
            <NoteRow key={note.id} note={note} today={today} />
          ))}
        </ol>
      )}
    </section>
  )
}

/** A note on the line of the day: its time, its text (changed in place), and the bin to delete it. */
function NoteRow({ note, today }: { note: Note; today: TodayState }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const box = useRef<HTMLParagraphElement>(null)
  // The text in the box is the page's while it is being changed; the note's text again when it changes from outside.
  useLayoutEffect(() => {
    if (box.current && document.activeElement !== box.current) box.current.textContent = note.text
  }, [note.text])
  const done = () => {
    const element = box.current
    if (!element) return
    const changed = (element.innerText ?? element.textContent ?? '').trim()
    if (!changed) element.textContent = note.text
    else if (changed !== note.text) void today.changeNote(note.id, changed)
  }
  return (
    <li className="group relative flex gap-4 rounded-xl py-2 pr-2 hover:bg-sheet-2/60">
      <span className="w-10 shrink-0 pt-0.5 text-right text-xs font-bold text-muted tabular-nums">{timeOf(note.created_at, me?.profile?.timezone)}</span>
      <span className="relative z-10 mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full border-2 border-sheet bg-accent" />
      <div className="min-w-0 flex-1">
        {note.prompt && <p className="mb-0.5 font-serif text-sm text-accent italic">{note.prompt}</p>}
        {note.unreadable ? (
          <p className="leading-relaxed text-muted italic">{t('today.unreadable')}</p>
        ) : !note.text && note.photo_id ? null : (
        <p
          ref={box}
          contentEditable="plaintext-only"
          suppressContentEditableWarning
          role="textbox"
          aria-label={t('today.editNote')}
          onBlur={done}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              e.currentTarget.textContent = note.text
              e.currentTarget.blur()
            }
          }}
          className="leading-relaxed break-words whitespace-pre-wrap text-ink focus:outline-none"
        />
        )}
        {note.photo_id && <img src={photoUrl(note.photo_id, true)} alt={t('photos.alt')} className="mt-2 h-24 w-36 rounded-lg object-cover" draggable={false} />}
      </div>
      <button
        type="button"
        onClick={() => void today.deleteNote(note.id)}
        className="self-start rounded-full p-1.5 text-muted opacity-0 group-hover:opacity-100 hover:text-ink focus:opacity-100 [@media(hover:none)]:opacity-100"
        aria-label={t('today.deleteNote')}
      >
        <Trash2 size={15} />
      </button>
    </li>
  )
}

function Bubbles({ today }: { today: TodayState }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const notes = today.data?.notes ?? []
  return (
    <div className="space-y-2.5">
      <p className="py-2 text-center text-xs font-semibold text-muted">{t('today.today')}</p>
      {notes.map((note) => (
        <div key={note.id} className="space-y-2.5">
          {note.prompt && (
            <div className="flex">
              <div className="max-w-[80%] rounded-[1.3rem] rounded-bl-md border border-line bg-sheet px-4 py-2.5 font-serif text-ink-2 italic">{note.prompt}</div>
            </div>
          )}
          <div className="group flex justify-end gap-2">
            <button
              type="button"
              onClick={() => void today.deleteNote(note.id)}
              className="self-center rounded-full p-1.5 text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
              aria-label={t('today.deleteNote')}
            >
              <Trash2 size={14} />
            </button>
            <div className="max-w-[85%] rounded-[1.3rem] rounded-br-md bg-accent-soft px-4 py-2.5 text-ink">
              {note.photo_id && <img src={photoUrl(note.photo_id, true)} alt={t('photos.alt')} className="mb-2 aspect-[16/10] w-56 max-w-full rounded-xl object-cover" draggable={false} />}
              {note.unreadable ? <p className="text-muted italic">{t('today.unreadable')}</p> : note.text && <p className="leading-relaxed break-words whitespace-pre-wrap">{note.text}</p>}
              <p className="mt-0.5 text-right text-[0.7rem] font-bold text-muted tabular-nums">{timeOf(note.created_at, me?.profile?.timezone)}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function Block({ title, extra, bare = false, children }: { title: string; extra?: ReactNode; bare?: boolean; children: ReactNode }) {
  return (
    <section className={bare ? '' : 'card p-5'}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  )
}

function ValuesBlock({ today, bare = false }: { today: TodayState; bare?: boolean }) {
  const { t } = useTranslation()
  const data = today.data as TodayData
  const asked: ValueDef[] = data.values.filter((value) => value.active)
  if (asked.length === 0) return null
  return (
    <Block title={t('today.howWasIt')} bare={bare} extra={<span className="text-sm text-muted">{t('today.voluntary')}</span>}>
      <div className="space-y-4">
        {asked.map((value) => (
          <div key={value.id}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="font-semibold">{value.name}</span>
              <span className="text-xs text-muted">{value.hint}</span>
            </div>
            <Scale label={value.name} value={data.day?.values[value.id]} low={value.low} high={value.high} onChange={(rating) => void today.rate(value.id, rating)} />
          </div>
        ))}
      </div>
    </Block>
  )
}

function TagsBlock({ today, bare = false }: { today: TodayState; bare?: boolean }) {
  const { t } = useTranslation()
  const tags = today.data?.day?.tags ?? []
  return (
    <Block title={t('today.tags')} bare={bare}>
      <TagPicker tags={tags} onChange={(next) => void today.setTags(next)} />
    </Block>
  )
}
