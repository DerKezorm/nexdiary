/**
 * The quick note for the phone, as the mock's `QuickPage.tsx`: one field with the keyboard open, today's notes above it,
 * no menus. Where a phone starts (Settings, Look, "On the phone"). "Alles" leads into the whole app.
 *
 * The camera button takes or picks a photo for the next note; under the notes "Den Tag aufschreiben" leads to "Today".
 * Above the field stands the question of the day: tapped, the next note is the answer and keeps the question; the
 * cross puts it away for this visit.
 */
import { ArrowUp, Camera, Check, Flame, LayoutGrid, MessageCircleQuestion, PenLine, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { photoUrl, type Question } from '../api/client'
import { LogoMark } from '../components/Logo'
import { PendingPhoto, usePendingPhoto } from '../components/PendingPhoto'
import { longDate, timeOf } from '../lib/dates'
import { errorText } from '../lib/errors'
import { PHOTO_ACCEPT } from '../lib/upload'
import { useAiState } from '../state/ai'
import { useAuth } from '../state/auth'
import { useToday } from '../state/today'

export function QuickPage() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const today = useToday()
  // Text shared into nexdiary from another app arrives in the address; it is only put into the field.
  const [text, setText] = useState(() => (new URLSearchParams(window.location.search).get('text') ?? '').slice(0, 5000))
  const [sent, setSent] = useState(false)
  /** The question the next note answers, while the person chose to answer it. */
  const [asking, setAsking] = useState<Question | null>(null)
  const [hidePrompt, setHidePrompt] = useState(false)
  const ai = useAiState()
  const question = today.data?.question
  const field = useRef<HTMLTextAreaElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const pending = usePendingPhoto(today)
  const notes = today.data?.notes ?? []

  // The newest note stands right above the field, like the last message in a chat.
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [notes.length])

  // The field grows with the text, up to a third of the screen.
  useEffect(() => {
    const element = field.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, window.innerHeight / 3)}px`
  }, [text])

  const send = async () => {
    if (!text.trim() && !pending.photo) return
    if (await today.addNote(text, pending.photo?.id ?? null, asking)) {
      setText('')
      setAsking(null)
      pending.sent()
      setSent(true)
      window.setTimeout(() => setSent(false), 900)
    }
    field.current?.focus()
  }

  return (
    <div className="flex h-dvh flex-col bg-paper">
      <header className="flex items-center gap-3 border-b border-line px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
        <LogoMark size={30} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{today.data ? longDate(today.data.date, i18n.language) : ' '}</p>
          <p className="text-xs text-muted">{notes.length === 0 ? t('quick.nothingYet') : t('quick.notesToday', { count: notes.length })}</p>
        </div>
        {today.data && (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-bold text-accent" title={t('today.streak')}>
            <Flame size={13} aria-hidden /> <span className="sr-only">{t('today.streak')}: </span>
            {today.data.streak}
          </span>
        )}
        <Link to="/" className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-sm font-semibold text-ink-2">
          <LayoutGrid size={15} aria-hidden /> {t('quick.all')}
        </Link>
      </header>

      <div ref={list} className="flex-1 overflow-y-auto px-4 py-4">
        {notes.length === 0 ? (
          <p className="mt-16 text-center font-serif text-lg text-muted">{t('quick.empty')}</p>
        ) : (
          <ol className="space-y-2.5">
            {notes.map((note) => (
              <li key={note.id} className="group">
                {note.prompt && <p className="mb-1 font-serif text-sm text-accent italic">{note.prompt}</p>}
                <div className="flex gap-3 rounded-2xl bg-sheet px-4 py-3 shadow-soft">
                  <span className="pt-0.5 text-xs font-bold text-muted tabular-nums">{timeOf(note.created_at, me?.profile?.timezone)}</span>
                  <div className="min-w-0 flex-1">
                    {note.unreadable ? <p className="text-muted italic">{t('today.unreadable')}</p> : note.text && <p className="leading-relaxed break-words whitespace-pre-wrap">{note.text}</p>}
                    {note.photo_id && <img src={photoUrl(note.photo_id, true)} alt={t('photos.alt')} className="mt-2 h-20 w-28 rounded-lg object-cover" draggable={false} />}
                  </div>
                  <button type="button" onClick={() => void today.deleteNote(note.id)} className="self-start rounded-full p-1 text-muted/60 hover:text-ink" aria-label={t('today.deleteNote')}>
                    <X size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
        {notes.length > 0 && (
          <Link to="/?aufschreiben=1" className="mt-5 flex items-center gap-3 rounded-2xl border border-dashed border-accent/40 bg-accent-soft/40 px-4 py-3.5">
            <PenLine size={19} className="shrink-0 text-accent" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{t('quick.writeUp')}</span>
              <span className="block text-xs text-muted">{ai?.available ? t('quick.writeUpHintAi') : t('quick.writeUpHint')}</span>
            </span>
            <span className="text-accent" aria-hidden>
              →
            </span>
          </Link>
        )}
      </div>

      <div className="border-t border-line bg-sheet/95 px-3 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
        {!hidePrompt && question && (
          <div className="mb-2 flex items-center gap-2 px-1">
            <button
              type="button"
              aria-pressed={asking !== null}
              aria-label={`${t('quick.promptAsk')}: ${question.text}`}
              onClick={() => {
                setAsking(asking ? null : question)
                field.current?.focus()
              }}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-full px-3 py-1.5 text-left text-sm ${asking ? 'bg-accent text-accent-ink' : 'bg-accent-soft text-accent'}`}
            >
              <MessageCircleQuestion size={15} className="shrink-0" aria-hidden />
              <span className="truncate font-serif">{question.text}</span>
            </button>
            <button type="button" onClick={() => (asking ? setAsking(null) : setHidePrompt(true))} className="rounded-full p-1.5 text-muted" aria-label={t('quick.promptHide')}>
              <X size={15} />
            </button>
          </div>
        )}
        {today.problem && (
          <p role="alert" className="mb-2 px-1 text-sm text-bad">
            {errorText(today.problem, today.problemValues)}
          </p>
        )}
        <PendingPhoto photo={pending.photo} busy={pending.busy} onDrop={pending.drop} />
        <div className="flex items-end gap-2">
          <button type="button" onClick={() => file.current?.click()} disabled={pending.busy} className="mb-0.5 rounded-full p-3 text-muted active:bg-sheet-2" aria-label={t('photos.take')}>
            <Camera size={22} />
          </button>
          <input
            ref={file}
            type="file"
            accept={PHOTO_ACCEPT}
            className="hidden"
            aria-label={t('photos.take')}
            onChange={(e) => {
              const picked = e.target.files?.[0]
              e.target.value = ''
              if (picked) void pending.pick(picked)
            }}
          />
          <textarea
            ref={field}
            autoFocus
            rows={1}
            value={text}
            maxLength={5000}
            aria-label={asking ? t('quick.answerPlaceholder') : t('quick.placeholder')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
            enterKeyHint="send"
            placeholder={asking ? t('quick.answerPlaceholder') : t('quick.placeholder')}
            className="min-h-12 flex-1 resize-none rounded-3xl border border-line bg-paper px-4 py-3 text-[1.05rem] leading-snug text-ink placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!text.trim() && !sent && !pending.photo}
            className="mb-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink transition disabled:opacity-30"
            aria-label={t('today.add')}
          >
            {sent ? <Check size={22} strokeWidth={3} /> : <ArrowUp size={22} />}
          </button>
        </div>
      </div>
    </div>
  )
}
