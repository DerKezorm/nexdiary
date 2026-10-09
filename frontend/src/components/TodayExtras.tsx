/**
 * New on "Today", as the mock's `TodayExtras.tsx`: the family question (and the quiet hint to join it), the questions of
 * the AI before a day is written up ("Erst fragen lassen", also on the writing page of a past day), and the short
 * entry for tired days ("Heute nur kurz").
 */
import { Loader2, MessageCircleHeart, Sparkles, Users } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { aiApi, ApiError, authApi, diaryApi, familyApi, type FamilyCard, type Followup } from '../api/client'
import { CoverImage, defaultCover } from '../covers/Cover'
import { timeOfHour } from '../covers/suggest'
import { longDate, timeOf } from '../lib/dates'
import { errorText } from '../lib/errors'
import { newId } from '../lib/ids'
import { nameOf } from '../lib/people'
import { useAuth } from '../state/auth'
import type { TodayState } from '../state/today'
import { Avatar } from './Avatar'
import { Dialog } from './Dialog'
import { Scale } from './Scale'

const PRIMARY = 'inline-flex h-11 items-center justify-center gap-2 rounded-full bg-accent px-5 text-[0.95rem] font-semibold text-accent-ink shadow-soft transition hover:brightness-105 disabled:pointer-events-none disabled:opacity-50'
const GHOST = 'inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-[0.95rem] font-semibold text-ink-2 transition hover:bg-sheet-2 disabled:pointer-events-none disabled:opacity-50'
const FIELD = 'rounded-xl border border-line bg-sheet text-ink placeholder:text-muted focus:border-accent focus:outline-none'

function codeOf(error: unknown): { code: string; values: Record<string, unknown> } {
  return error instanceof ApiError ? { code: error.code, values: error.values } : { code: 'internal_error', values: {} }
}

/** "Tom und Oma Ruth", "Tom, Ruth und Mia": names as a sentence says them, in the language of the page. */
function namesOf(names: string[], language: string): string {
  try {
    return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}

// --- The family question ---------------------------------------------------------------------------------------------

/** The answers as bubbles: the others' on the left with their name, the own on the right. */
function AnswerBubbles({ card }: { card: FamilyCard }) {
  const { t } = useTranslation()
  const byId = new Map(card.people.map((person) => [person.id, person]))
  const self = card.people.find((person) => person.me)
  const mine = card.mine
  return (
    <>
      {(card.answers ?? []).map((item) => {
        const person = byId.get(item.from)
        if (!person) return null
        return (
          <div key={item.from} className="flex items-end gap-2.5">
            <Avatar person={person} size={26} />
            <div className="max-w-[80%] min-w-0 rounded-2xl rounded-bl-md bg-sheet-2 px-3.5 py-2 text-ink">
              <p className="text-xs font-bold opacity-70">{nameOf(person)}</p>
              <p className="font-serif leading-snug break-words whitespace-pre-wrap">{item.text}</p>
            </div>
          </div>
        )
      })}
      {mine && (
        <div className="flex flex-row-reverse items-end gap-2.5" data-mine>
          {self && <Avatar person={self} size={26} />}
          <div className="max-w-[80%] min-w-0 rounded-2xl rounded-br-md bg-accent px-3.5 py-2 text-accent-ink">
            <p className="font-serif leading-snug break-words whitespace-pre-wrap">{mine.unreadable ? t('family.unreadable') : mine.text}</p>
          </div>
        </div>
      )}
    </>
  )
}

/** The family question of a day, read again on the reading page of that day: the server gives it only to a person who
 * answered on that date (else null, and nothing shows), with the answers of those who answered too. */
export function FamilyOfDay({ card }: { card: FamilyCard }) {
  const { t } = useTranslation()
  return (
    <section className="card overflow-hidden" aria-label={t('family.ofDay')} data-family-day>
      <div className="flex items-start gap-3 px-5 pt-4 pb-3">
        <Users size={20} className="mt-0.5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold tracking-wide text-accent uppercase">{t('family.title')}</p>
          <p className="mt-0.5 font-serif text-lg leading-snug text-ink" data-family-question>
            {card.question.text}
          </p>
        </div>
      </div>
      <div className="space-y-2.5 px-5 pb-5" data-answers>
        <AnswerBubbles card={card} />
      </div>
    </section>
  )
}

/** Everybody who joined answers the same question; the answers of the others open after the own. The server keeps
 * that rule: before the own answer the card knows who answered, nothing of what. An answer is final: the card says so
 * under the field, and there is nothing to change afterwards. */
export function FamilyQuestion({ today }: { today: TodayState }) {
  const { t, i18n } = useTranslation()
  const card = today.data?.family
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ code: string; values: Record<string, unknown> } | null>(null)
  /** The note the answer becomes: the same id until the server took it, so a double press keeps one note. */
  const noteId = useRef(newId())
  if (!card) return null
  const others = card.people.filter((person) => !person.me)
  const answered = others.filter((person) => person.answered)
  const waiting = others.filter((person) => !person.answered)
  const mine = card.mine

  const run = async (call: () => Promise<FamilyCard>) => {
    if (busy) return false
    setBusy(true)
    setProblem(null)
    try {
      await call()
      // The card comes back with the day: the note the answer became stands among the notes.
      await today.load()
      return true
    } catch (error) {
      setProblem(codeOf(error))
      // Answered already (on another device, or a reply lost on the way): the card shows the answer that stands.
      if (error instanceof ApiError && error.code === 'family_answered') await today.load().catch(() => undefined)
      return false
    } finally {
      setBusy(false)
    }
  }
  const send = async () => {
    const words = text.trim()
    if (!words) return
    if (await run(() => familyApi.answer(card.date, words, noteId.current))) {
      noteId.current = newId()
      setText('')
    }
  }
  const field = (
    <>
      <div className="flex items-end gap-2">
      <textarea
        rows={1}
        value={text}
        maxLength={500}
        aria-label={t('family.label')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void send()
          }
        }}
        placeholder={t('family.placeholder')}
        className={`min-h-11 min-w-0 flex-1 resize-none px-3 py-2.5 ${FIELD}`}
      />
      <button type="button" className={`${PRIMARY} shrink-0`} onClick={() => void send()} disabled={!text.trim() || busy}>
        {busy ? <Loader2 size={17} className="animate-spin" aria-hidden /> : null}
        {t('family.answer')}
      </button>
      </div>
      <p className="mt-1.5 text-xs text-muted" data-family-final>
        {t('family.final')}
      </p>
    </>
  )

  return (
    <section className="card overflow-hidden" aria-label={t('family.title')} data-family>
      <div className="flex items-start gap-3 px-5 pt-4 pb-3">
        <Users size={20} className="mt-0.5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold tracking-wide text-accent uppercase">{t('family.title')}</p>
          <p className="mt-0.5 font-serif text-lg leading-snug text-ink" data-family-question>
            {card.question.text}
          </p>
        </div>
        {others.length > 0 && (
          <div className="flex shrink-0 -space-x-2" role="list" aria-label={t('family.people')}>
            {[...answered, ...waiting].map((person) => (
              <span key={person.id} role="listitem" data-answered={person.answered} className={`rounded-full ring-2 ring-sheet ${person.answered ? '' : 'opacity-35'}`}>
                <Avatar person={person} size={26} />
              </span>
            ))}
          </div>
        )}
      </div>
      {mine === null || card.answers === null ? (
        <div className="px-5 pb-5">
          {answered.length > 0 && (
            <div className="mb-3 space-y-2" aria-hidden data-placeholders>
              {answered.map((person) => (
                <div key={person.id} className="flex items-center gap-2.5">
                  <Avatar person={person} size={26} />
                  {/* The width says nothing of the answer: the server has not given out a word of it. */}
                  <span className="h-8 flex-1 rounded-2xl bg-sheet-2 blur-[1px]" style={{ maxWidth: `${42 + ((person.id * 29) % 40)}%` }} />
                </div>
              ))}
            </div>
          )}
          <p className="mb-3 text-sm text-ink-2">
            {answered.length > 0
              ? t('family.answeredBefore', { count: answered.length, names: namesOf(answered.map(nameOf), i18n.language) })
              : t('family.nobodyYet')}
          </p>
          {field}
        </div>
      ) : (
        <div className="rise space-y-2.5 px-5 pb-5" data-answers>
          <AnswerBubbles card={card} />
          <p className="pt-1 text-xs text-muted">
            {waiting.length > 0 && `${t('family.waiting', { count: waiting.length, names: namesOf(waiting.map(nameOf), i18n.language) })} `}
            {t('family.inNotes')}
          </p>
        </div>
      )}
      {problem && (
        <p role="alert" className="px-5 pb-4 text-sm text-bad">
          {errorText(problem.code, problem.values)}
        </p>
      )}
    </section>
  )
}

/** Once, quietly: others take part in the family question. Joining shows the card; "Nicht mehr zeigen" puts it away
 * for good (kept with the account). */
export function FamilyHint({ today }: { today: TodayState }) {
  const { t } = useTranslation()
  const { me, setMe } = useAuth()
  const [gone, setGone] = useState(false)
  const [busy, setBusy] = useState(false)
  if (gone || !today.data?.family_hint || today.data.family) return null
  const choose = async (change: { family?: boolean; family_hint?: boolean }) => {
    setBusy(true)
    try {
      const profile = await authApi.preferences(change)
      if (me) setMe?.({ ...me, profile })
      setGone(true)
      if (change.family) await today.load()
    } catch {
      // Stays as it was; the next visit asks again.
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-sheet-2 px-3.5 py-2.5 text-sm text-ink-2" data-family-hint>
      <Users size={16} className="shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1">{t('family.hint')}</span>
      <span className="flex shrink-0 gap-3 font-semibold">
        <button type="button" className="text-accent hover:underline" disabled={busy} onClick={() => void choose({ family: true })}>
          {t('family.hintJoin')}
        </button>
        <button type="button" className="text-muted hover:text-ink" disabled={busy} onClick={() => void choose({ family_hint: false })}>
          {t('family.hintDismiss')}
        </button>
      </span>
    </div>
  )
}

// --- The AI asks first -----------------------------------------------------------------------------------------------

/** Before writing: the AI asks about what the notes leave open (two questions at most). The answers become notes of
 * the day with their question, then the day is written up with all of them (`onDone`). */
export function FollowupDialog({ date, onClose, onDone }: { date: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [questions, setQuestions] = useState<Followup[] | null>(null)
  const [answers, setAnswers] = useState<string[]>([])
  const [problem, setProblem] = useState<{ code: string; values: Record<string, unknown> } | null>(null)
  const [busy, setBusy] = useState(false)
  /** The id of the note each answer becomes: the same press twice keeps one note. */
  const ids = useRef<string[]>([])
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    aiApi.followups(date).then(
      (found) => {
        ids.current = found.questions.map(() => newId())
        setAnswers(found.questions.map(() => ''))
        setQuestions(found.questions)
      },
      (error) => {
        setProblem(codeOf(error))
        setQuestions([])
      },
    )
  }, [date])

  const go = async () => {
    if (busy || !questions) return
    setBusy(true)
    setProblem(null)
    try {
      for (const [index, followup] of questions.entries()) {
        const words = answers[index]?.trim()
        if (!words) continue
        try {
          await diaryApi.addNote(ids.current[index], words, date, null, { id: '', text: followup.question })
        } catch (error) {
          // The answer was changed after a send whose reply got lost: the old id holds the old words.
          if (!(error instanceof ApiError && error.code === 'note_id_taken')) throw error
          ids.current[index] = newId()
          await diaryApi.addNote(ids.current[index], words, date, null, { id: '', text: followup.question })
        }
      }
      onDone()
    } catch (error) {
      setProblem(codeOf(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title={t('followups.title')} onClose={onClose}>
      {questions === null ? (
        <>
          <p className="-mt-2 text-sm text-ink-2" data-followups-explain>
            {t('followups.explain')}
          </p>
          <p className="flex items-center gap-2 py-8 text-ink-2" role="status">
            <Loader2 size={18} className="animate-spin text-accent" aria-hidden /> {t('followups.reading')}
          </p>
        </>
      ) : (
        <div className="space-y-5">
          {questions.length > 0 ? (
            <>
              <p className="-mt-2 text-sm text-ink-2">{t('followups.intro')}</p>
              {questions.map((followup, index) => (
                <label key={followup.note_id + followup.question} className="block">
                  <span className="flex items-start gap-2 font-serif text-[1.05rem] leading-snug text-ink">
                    <MessageCircleHeart size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden /> {followup.question}
                  </span>
                  <span className="mt-0.5 block pl-[26px] text-xs text-muted">{t('followups.about', { time: timeOf(followup.at, me?.profile?.timezone) })}</span>
                  <textarea
                    rows={2}
                    value={answers[index] ?? ''}
                    maxLength={5000}
                    onChange={(e) => setAnswers(answers.map((answer, other) => (other === index ? e.target.value : answer)))}
                    placeholder={t('followups.placeholder')}
                    className={`mt-2 w-full resize-none px-3 py-2 ${FIELD}`}
                  />
                </label>
              ))}
            </>
          ) : (
            !problem && <p className="-mt-2 text-sm text-ink-2">{t('followups.nothingOpen')}</p>
          )}
          {problem && (
            <p role="alert" className="text-sm text-bad">
              {errorText(problem.code, problem.values)}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {questions.length > 0 && (
              <button type="button" className={GHOST} onClick={onDone} disabled={busy}>
                {t('followups.skip')}
              </button>
            )}
            <button type="button" className={PRIMARY} onClick={() => void go()} disabled={busy}>
              {busy ? <Loader2 size={17} className="animate-spin" aria-hidden /> : <Sparkles size={17} aria-hidden />} {t('followups.go')}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

// --- Just briefly today -----------------------------------------------------------------------------------------------

/** The hour on the person's clock, for the illustration that fits the time of day. */
function hourIn(moment: Date, zone?: string): number {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: zone || undefined }).format(moment))
  } catch {
    return moment.getHours()
  }
}

/** A short entry for tired days: the first value and one sentence, and the day counts. Afterwards the page of the day
 * with the streak, as after any save. */
export function ShortEntry({ today, onClose, now }: { today: TodayState; onClose: () => void; now?: Date }) {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const navigate = useNavigate()
  const data = today.data
  const value = data?.values.find((item) => item.active && !item.unreadable) ?? null
  const [rating, setRating] = useState<number | undefined>(value ? data?.day?.values[value.id] : undefined)
  const [line, setLine] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ code: string; values: Record<string, unknown> } | null>(null)
  const [moment] = useState(() => now ?? new Date())
  if (!data) return null
  const notes = data.notes
  const photos = data.photos.filter((photo) => !photo.on_note && !notes.some((note) => note.photo_id === photo.id))
  const cover = data.day?.cover_chosen ? data.day.cover : defaultCover(data.date, data.day?.tags ?? [], photos, timeOfHour(hourIn(moment, me?.profile?.timezone)))
  const ok = line.trim().length > 0 && (value === null || rating !== undefined)
  const named = value ? { value: value.name } : {}

  const save = async () => {
    if (!ok || busy) return
    setBusy(true)
    setProblem(null)
    try {
      await diaryApi.short(data.date, { text: line.trim(), title: longDate(data.date, i18n.language), cover, ...(value && rating !== undefined ? { rating } : {}) })
      let notice = t('write.savedPlain')
      try {
        const streak = (await diaryApi.today()).streak
        if (streak > 0) notice = t('write.saved', { count: streak })
      } catch {
        // The plain word then.
      }
      navigate(`/tag/${data.date}`, { state: { notice } })
    } catch (error) {
      setProblem(codeOf(error))
      setBusy(false)
    }
  }

  return (
    <Dialog title={t('short.title')} onClose={onClose}>
      <p className="-mt-2 mb-5 text-sm text-ink-2">{value ? t('short.intro', named) : t('short.introNoValue')}</p>
      <div className="space-y-5">
        {value && (
          <div>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <p className="text-sm font-bold text-ink-2">{t('short.how')}</p>
              <span className="truncate text-xs text-muted">{value.name}</span>
            </div>
            <Scale label={value.name} value={rating} onChange={(next) => setRating(next ?? undefined)} low={value.low} high={value.high} />
          </div>
        )}
        <div>
          <p className="mb-2 text-sm font-bold text-ink-2">{t('short.sentence')}</p>
          <input
            autoFocus
            value={line}
            maxLength={280}
            aria-label={t('short.sentence')}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void save()
              }
            }}
            placeholder={t('short.placeholder')}
            className={`w-full px-4 py-3 font-serif text-[1.05rem] ${FIELD}`}
          />
        </div>
        <div className="flex items-center gap-3 rounded-xl bg-sheet-2 p-2.5" data-short-cover={cover}>
          <CoverImage cover={cover} className="h-12 w-20 shrink-0 rounded-lg" />
          <p className="text-sm text-ink-2">{t('short.cover')}</p>
        </div>
        {problem && (
          <p role="alert" className="text-sm text-bad">
            {errorText(problem.code, problem.values)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={GHOST} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className={PRIMARY} onClick={() => void save()} disabled={!ok || busy}>
            {busy && <Loader2 size={17} className="animate-spin" aria-hidden />} {t('common.save')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}

