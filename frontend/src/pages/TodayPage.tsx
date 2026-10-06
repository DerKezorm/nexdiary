/**
 * "Today", as the mock's `Today.tsx`, in the three layouts a person chooses under Settings, Look: one page, two columns,
 * or like a chat. Notes are thrown down here, changed and deleted; the values of the day are rated.
 *
 * What comes with later blocks has its place in every layout already and stays empty until then: the question of the
 * day (`PromptSlot`), the photos (`PhotosSlot`) and writing the day up (`FinishSlot`).
 */
import { ArrowUp, Flame, Plus, Tag, Trash2, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { Note, TodayData, ValueDef } from '../api/client'
import { Chip } from '../components/Chip'
import { Dialog } from '../components/Dialog'
import { Scale } from '../components/Scale'
import { longDate, timeOf } from '../lib/dates'
import { errorText } from '../lib/errors'
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
  const problem = today.problem && <Problem code={today.problem} />

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
        <FinishSlot />
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
              <PhotosSlot />
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
            <FinishSlot />
            <ValuesBlock today={today} />
            <PhotosSlot />
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
      <PhotosSlot />
      <ValuesBlock today={today} />
      <TagsBlock today={today} />
      <FinishSlot />
    </div>
  )
}

/** The question of the day: comes with the writing prompts. */
function PromptSlot() {
  return null
}

/** The photos of the day: come with photos and Immich. */
function PhotosSlot() {
  return null
}

/** "Write the day up": comes with writing. */
function FinishSlot() {
  return null
}

function Problem({ code }: { code: string }) {
  return (
    <p role="alert" className="rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
      {errorText(code)}
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
  const add = async () => {
    if (!text.trim()) return
    if (await today.addNote(text)) setText('')
    field.current?.focus()
  }
  return (
    <div className={`card flex items-end gap-2 p-2 ${chat ? 'rounded-[1.6rem]' : ''}`}>
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
        className="max-h-40 min-h-11 flex-1 resize-none bg-transparent px-3 py-2.5 text-[1.02rem] text-ink placeholder:text-muted focus:outline-none"
      />
      <button type="button" onClick={() => void add()} disabled={!text.trim()} className="rounded-full bg-accent p-2.5 text-accent-ink transition disabled:opacity-30" aria-label={t('today.add')}>
        <ArrowUp size={20} />
      </button>
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
        ) : (
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
              {note.unreadable ? <p className="text-muted italic">{t('today.unreadable')}</p> : <p className="leading-relaxed break-words whitespace-pre-wrap">{note.text}</p>}
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
  const [open, setOpen] = useState(false)
  const [own, setOwn] = useState('')
  const tags = today.data?.day?.tags ?? []
  const toggle = (tag: string) => void today.setTags(tags.includes(tag) ? tags.filter((x) => x !== tag) : [...tags, tag])
  const suggestions = t('today.tagSuggestions')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag && !tags.includes(tag))
  return (
    <Block title={t('today.tags')} bare={bare}>
      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <Chip key={tag} active onClick={() => toggle(tag)} label={t('today.removeTag', { tag })}>
            <Tag size={13} aria-hidden /> {tag} <X size={13} aria-hidden />
          </Chip>
        ))}
        <Chip onClick={() => setOpen(!open)} label={t('today.addTag')}>
          <Plus size={14} aria-hidden /> {t('today.tag')}
        </Chip>
      </div>
      {open && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex flex-wrap gap-2">
            {suggestions.map((tag) => (
              <Chip key={tag} onClick={() => toggle(tag)}>
                {tag}
              </Chip>
            ))}
          </div>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const tag = own.trim().replace(/^#/, '').toLowerCase()
              if (tag && !tags.includes(tag)) void today.setTags([...tags, tag])
              setOwn('')
            }}
          >
            <input
              value={own}
              maxLength={40}
              onChange={(e) => setOwn(e.target.value)}
              placeholder={t('today.ownTag')}
              aria-label={t('today.ownTag')}
              className="h-8 min-w-0 flex-1 rounded-full border border-line bg-sheet px-3 text-sm text-ink outline-none placeholder:text-muted/70 focus:border-accent"
            />
            <button type="submit" disabled={!own.trim()} className="inline-flex h-8 items-center rounded-full border border-line px-3 text-sm font-semibold text-ink-2 hover:bg-sheet-2 disabled:opacity-50">
              {t('today.addTagButton')}
            </button>
          </form>
        </div>
      )}
    </Block>
  )
}
