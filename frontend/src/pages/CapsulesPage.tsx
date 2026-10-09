/**
 * Time capsules, as the mock's `CapsulesPage.tsx`: letters that open on a date, to oneself or to others on the server,
 * not tied to a day of the diary. Until its day a recipient sees who wrote and when it opens, nothing more; a letter
 * only to oneself is sealed for its writer too. Every rule lives on the server: this page shows what it was given.
 */
import { Hourglass, ImagePlus, Lock, MailOpen, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'

import { ApiError, capsulePhotoUrl, capsulesApi, sharingApi, type CapsuleDraft, type CapsuleForMe, type CapsuleFromMe, type CapsuleLists, type CapsuleView, type Me, type Person } from '../api/client'
import { Avatar } from '../components/Avatar'
import { Dialog } from '../components/Dialog'
import { addDays, longDate } from '../lib/dates'
import { errorText } from '../lib/errors'
import { newId } from '../lib/ids'
import { nameOf } from '../lib/people'
import { PHOTO_ACCEPT } from '../lib/upload'
import { useAuth } from '../state/auth'
import { useCapsules } from '../state/capsules'
import { TabRow } from './settings/ui'

type Tab = 'fuer-mich' | 'von-mir'
type T = ReturnType<typeof useTranslation>['t']

const PRIMARY = 'inline-flex h-11 items-center justify-center gap-2 rounded-full bg-accent px-5 text-[0.95rem] font-semibold text-accent-ink shadow-soft transition hover:brightness-105 disabled:pointer-events-none disabled:opacity-50'
const GHOST = 'inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-[0.95rem] font-semibold text-ink-2 transition hover:bg-sheet-2'
const GHOST_SMALL = 'inline-flex h-8 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold text-ink-2 transition hover:bg-sheet-2 disabled:pointer-events-none disabled:opacity-50'
const SOFT_SMALL = 'inline-flex h-8 items-center justify-center gap-2 rounded-full bg-accent-soft px-3.5 text-sm font-semibold text-accent transition hover:brightness-[0.98] disabled:pointer-events-none disabled:opacity-50'

/** Somebody whose account is gone: a capsule from them stays, with a plain sign instead of a picture. */
const NOBODY: Person = { id: 0, name: '?', display_name: '', avatar: null }

function utc(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return Date.UTC(year, month - 1, date)
}

/** Whole days from `from` to `to`, calendar days both. */
// eslint-disable-next-line react-refresh/only-export-components
export function daysBetween(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / 86_400_000)
}

/** "morgen", "in 12 Tagen", "in 3 Monaten", "in 11 Jahren"; "offen" once the day has come. */
// eslint-disable-next-line react-refresh/only-export-components
export function untilText(t: T, today: string, day: string): string {
  const n = daysBetween(today, day)
  if (n <= 0) return t('capsules.untilOpen')
  if (n === 1) return t('capsules.untilTomorrow')
  if (n < 60) return t('capsules.untilDays', { count: n })
  if (n < 730) return t('capsules.untilMonths', { count: Math.round(n / 30.4) })
  return t('capsules.untilYears', { count: Math.round(n / 365.25) })
}

/** "gestern", "vor 5 Tagen", "vor 3 Monaten", "vor 1 Jahr": how long ago a letter was written. */
function agoText(t: T, today: string, written: string): string {
  const n = Math.max(1, daysBetween(written, today))
  if (n >= 365) return t('capsules.agoYears', { count: Math.floor(n / 365.25) || 1 })
  if (n >= 30) return t('capsules.agoMonths', { count: Math.floor(n / 30.4) || 1 })
  return t('capsules.agoDays', { count: n })
}

/** The same day so many years on; 29 February becomes the 28th where the year has none. */
function yearsLater(day: string, years: number): string {
  const [year, month, date] = day.split('-').map(Number)
  const later = new Date(Date.UTC(year + years, month - 1, date))
  if (later.getUTCMonth() !== month - 1) later.setUTCDate(0)
  return later.toISOString().slice(0, 10)
}

function listOf(language: string, names: string[]): string {
  return new Intl.ListFormat(language, { type: 'conjunction' }).format(names)
}

export function CapsulesPage() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const { refresh } = useCapsules()
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const tab: Tab = params.get('tab') === 'von-mir' ? 'von-mir' : 'fuer-mich'
  const [data, setData] = useState<CapsuleLists | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [reading, setReading] = useState<CapsuleForMe | null>(null)
  const [editing, setEditing] = useState<CapsuleView | 'neu' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    capsulesApi.lists().then(setData, (error) => setProblem(error instanceof ApiError ? error.code : 'internal_error'))
  }, [])
  useEffect(() => load(), [load])
  // Stable, so that the dialogs do not take the focus back while the page around them changes.
  const closeReading = useCallback(() => setReading(null), [])
  const closeEditing = useCallback(() => setEditing(null), [])

  const say = (notice: string, to?: Tab) => {
    const search = to === undefined ? location.search : to === 'von-mir' ? '?tab=von-mir' : ''
    navigate(location.pathname + search, { replace: true, state: { notice } })
  }
  const fail = (error: unknown) => setProblem(error instanceof ApiError ? error.code : 'internal_error')

  if (!me) return null
  const today = data?.today ?? ''
  const forMe = data?.for_me ?? []
  const mine = data?.from_me ?? []
  const open = forMe.filter((item) => item.open)
  const waiting = forMe.filter((item) => !item.open)
  const todays = open.filter((item) => item.opens_on === today)
  const fresh = todays.find((item) => item.new) ?? todays[0]
  const date = (day: string) => longDate(day, i18n.language, true)
  const fromName = (item: { from: Person | null; self: boolean }) => (item.self ? t('capsules.fromYou') : item.from ? nameOf(item.from) : t('capsules.fromGone'))
  const names = (people: Person[]) => listOf(i18n.language, people.map((person) => (person.id === me.id ? t('capsules.yourself') : nameOf(person))))

  const change = async (item: CapsuleFromMe) => {
    setBusy(item.id)
    setProblem(null)
    try {
      setEditing(await capsulesApi.one(item.id))
    } catch (error) {
      fail(error)
    } finally {
      setBusy(null)
    }
  }

  const withdraw = async (item: CapsuleFromMe) => {
    if (busy) return
    setBusy(item.id)
    setProblem(null)
    try {
      await capsulesApi.withdraw(item.id)
      setData((current) => current && { ...current, from_me: current.from_me.filter((other) => other.id !== item.id), for_me: current.for_me.filter((other) => other.id !== item.id) })
      say(t('capsules.withdrawn'))
    } catch (error) {
      fail(error)
      load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="page space-y-5 pt-8 pb-28 lg:pb-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t('capsules.title')}</h1>
          <p className="mt-1 max-w-xl text-ink-2">{t('capsules.intro')}</p>
        </div>
        <button type="button" className={PRIMARY} onClick={() => setEditing('neu')} disabled={!data}>
          <Plus size={18} aria-hidden /> {t('capsules.newCapsule')}
        </button>
      </header>

      {fresh && <OpenedToday item={fresh} today={today} fromName={fromName(fresh)} onRead={() => setReading(fresh)} />}

      <TabRow
        label={t('capsules.title')}
        tabs={[
          { value: 'fuer-mich', label: t('capsules.forMe', { count: forMe.length }), icon: MailOpen },
          { value: 'von-mir', label: t('capsules.fromMe', { count: mine.length }), icon: Send },
        ]}
        active={tab}
        onChange={(value: Tab) => setParams(value === 'fuer-mich' ? {} : { tab: value }, { replace: true })}
      />
      {problem && <p className="text-sm text-bad">{errorText(problem)}</p>}

      {data === null ? null : tab === 'fuer-mich' ? (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 font-display text-xl font-semibold text-ink-2">{t('capsules.waiting')}</h2>
            {waiting.length === 0 ? (
              <p className="card p-6 text-center text-ink-2">{t('capsules.noneWaiting')}</p>
            ) : (
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {waiting.map((item) => (
                  <Sealed key={item.id} item={item} today={today} fromName={fromName(item)} />
                ))}
              </div>
            )}
          </section>
          {open.length > 0 && (
            <section>
              <h2 className="mb-3 font-display text-xl font-semibold text-ink-2">{t('capsules.opened')}</h2>
              <div className="card divide-y divide-line overflow-hidden">
                {open.map((item) => (
                  <button key={item.id} type="button" onClick={() => setReading(item)} className="flex w-full items-center gap-4 px-5 py-4 text-left hover:bg-sheet-2/50">
                    <Avatar person={item.self ? me : (item.from ?? NOBODY)} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-display text-lg font-semibold">{item.title}</span>
                      <span className="block text-xs text-muted">{t('capsules.writtenBy', { name: fromName(item), date: date(item.written_on) })}</span>
                    </span>
                    {item.new && <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-accent-ink">{t('capsules.unread')}</span>}
                    <MailOpen size={18} className="shrink-0 text-accent" aria-hidden />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      ) : mine.length === 0 ? (
        <p className="card p-8 text-center text-ink-2">{t('capsules.noneSent')}</p>
      ) : (
        <div className="card divide-y divide-line overflow-hidden">
          {mine.map((item) => (
            <div key={item.id} className="flex flex-wrap items-center gap-4 px-5 py-4" data-capsule={item.id}>
              <span className="flex shrink-0 -space-x-2">
                {item.to.map((person) => (
                  <span key={person.id} className="rounded-full ring-2 ring-sheet">
                    <Avatar person={person} size={36} />
                  </span>
                ))}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-display text-lg font-semibold">{item.title}</div>
                <div className="text-xs text-muted">
                  {item.opened ? t('capsules.toLineOpen', { names: names(item.to), date: date(item.opens_on) }) : t('capsules.toLine', { names: names(item.to), date: date(item.opens_on), until: untilText(t, today, item.opens_on) })}
                </div>
              </div>
              {!item.opened && (
                <div className="flex items-center gap-1">
                  {item.sealed ? (
                    <span className="mr-2 inline-flex items-center gap-1.5 text-xs font-semibold text-muted" title={t('capsules.sealedHint')}>
                      <Lock size={13} aria-hidden /> {t('capsules.sealed')}
                    </span>
                  ) : (
                    <button type="button" className={GHOST_SMALL} onClick={() => void change(item)} disabled={busy !== null}>
                      <Pencil size={14} aria-hidden /> {t('capsules.change')}
                    </button>
                  )}
                  <button type="button" className={GHOST_SMALL} onClick={() => void withdraw(item)} disabled={busy !== null}>
                    <Trash2 size={14} aria-hidden /> {t('capsules.withdraw')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {reading && (
        <Letter
          item={reading}
          fromName={fromName(reading)}
          me={me}
          onClose={closeReading}
          onRead={() => {
            setData((current) => current && { ...current, for_me: current.for_me.map((other) => (other.id === reading.id ? { ...other, new: false } : other)) })
            refresh()
          }}
        />
      )}
      {editing && today && (
        <Compose
          start={editing === 'neu' ? null : editing}
          today={today}
          me={me}
          onClose={closeEditing}
          onSaved={(saved) => {
            setEditing(null)
            load()
            say(t('capsules.closedUntil', { date: date(saved.opens_on) }), 'von-mir')
          }}
        />
      )}
    </div>
  )
}

function OpenedToday({ item, today, fromName, onRead }: { item: CapsuleForMe; today: string; fromName: string; onRead: () => void }) {
  const { t, i18n } = useTranslation()
  const ago = agoText(t, today, item.written_on)
  const written = longDate(item.written_on, i18n.language, true)
  const line = item.self ? t('capsules.todayBySelf', { ago, date: written }) : item.from ? t('capsules.todayBy', { name: fromName, ago, date: written }) : t('capsules.todayByGone', { ago, date: written })
  return (
    <section className="card relative overflow-hidden" aria-label={t('capsules.openedToday')}>
      <div className="grid md:grid-cols-[1fr_1.1fr]">
        {item.photo && <img src={capsulePhotoUrl(item.id)} alt={t('capsules.photoAlt')} className="aspect-[16/9] h-full w-full object-cover md:aspect-auto" />}
        <div className="p-6 sm:p-8">
          <p className="text-xs font-bold tracking-wide text-accent uppercase">{t('capsules.openedToday')}</p>
          <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight break-words sm:text-3xl">{item.title}</h2>
          <p className="mt-2 text-ink-2">{line}</p>
          <button type="button" className={`${PRIMARY} mt-5`} onClick={onRead}>
            <MailOpen size={18} aria-hidden /> {t('capsules.read')}
          </button>
        </div>
      </div>
    </section>
  )
}

/** A sealed capsule: who wrote it and when it opens, nothing more. */
function Sealed({ item, today, fromName }: { item: CapsuleForMe; today: string; fromName: string }) {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const total = Math.max(1, daysBetween(item.written_on, item.opens_on))
  const done = 1 - daysBetween(today, item.opens_on) / total
  return (
    <div className="card relative flex flex-col overflow-hidden" data-sealed={item.id}>
      <div className="relative flex aspect-[16/9] items-center justify-center bg-sheet-2">
        <svg viewBox="0 0 160 90" className="absolute inset-0 h-full w-full" aria-hidden preserveAspectRatio="none">
          <path d="M0 0 L80 52 L160 0" fill="none" stroke="var(--line)" strokeWidth="1.5" />
          <path d="M0 90 L62 40 M160 90 L98 40" fill="none" stroke="var(--line)" strokeWidth="1.5" />
        </svg>
        <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-ink shadow-soft ring-4 ring-accent/25">
          <Lock size={22} aria-hidden />
        </span>
      </div>
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-center gap-2.5">
          <Avatar person={item.self && me ? me : (item.from ?? NOBODY)} size={28} />
          <span className="min-w-0 truncate text-sm">
            {t('capsules.fromWord')} <span className="font-semibold">{fromName}</span>
          </span>
        </div>
        <h3 className="mt-3 font-display text-xl font-semibold break-words">{item.title}</h3>
        <p className="mt-1 text-sm text-ink-2">{t('capsules.opensOn', { date: longDate(item.opens_on, i18n.language, true) })}</p>
        <div className="mt-auto pt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-sheet-2">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(3, done * 100))}%` }} />
          </div>
          <p className="mt-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted">
            <Hourglass size={12} aria-hidden /> {untilText(t, today, item.opens_on)}
          </p>
        </div>
      </div>
    </div>
  )
}

/** The letter itself, read on its day. Opening it marks it read: the mark at "Zeitkapseln" goes. */
function Letter({ item, fromName, me, onClose, onRead }: { item: CapsuleForMe; fromName: string; me: Me; onClose: () => void; onRead: () => void }) {
  const { t, i18n } = useTranslation()
  const [letter, setLetter] = useState<CapsuleView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const wasNew = useRef(item.new)
  const readNow = useRef(onRead)
  readNow.current = onRead
  useEffect(() => {
    let alive = true
    capsulesApi.one(item.id).then(
      (found) => {
        if (!alive) return
        setLetter(found)
        if (wasNew.current && found.text !== undefined) capsulesApi.read(item.id).then(() => readNow.current(), () => undefined)
      },
      (error) => alive && setProblem(error instanceof ApiError ? error.code : 'internal_error'),
    )
    return () => {
      alive = false
    }
  }, [item.id])
  const paragraphs = (letter?.text ?? '').split(/\n\s*\n/).filter((part) => part.trim())
  return (
    <Dialog title={item.title} onClose={onClose} wide>
      <div className="-mt-2 mb-5 flex items-center gap-2.5 text-sm text-ink-2">
        <Avatar person={item.self ? me : (item.from ?? NOBODY)} size={28} />
        <span className="min-w-0">{t('capsules.letterMeta', { name: fromName, written: longDate(item.written_on, i18n.language, true), opened: longDate(item.opens_on, i18n.language, true) })}</span>
      </div>
      {problem && <p className="text-sm text-bad">{problem === 'not_found' ? t('capsules.gone') : errorText(problem)}</p>}
      {letter?.photo && <img src={capsulePhotoUrl(item.id)} alt={t('capsules.photoAlt')} className="mb-5 aspect-[16/8] w-full rounded-xl object-cover" />}
      {letter && (
        <div className="prose-diary font-serif text-[1.08rem] leading-relaxed" data-letter>
          {paragraphs.map((part, index) => (
            <p key={index} className="whitespace-pre-line">
              {part}
            </p>
          ))}
        </div>
      )}
    </Dialog>
  )
}

type PhotoChoice = { kind: 'keep' } | { kind: 'none' } | { kind: 'new'; id: string; url: string }

/** "Neue Zeitkapsel" and "Zeitkapsel ändern": for whom (several, oneself among them), when, the letter, a photo. */
function Compose({ start, today, me, onClose, onSaved }: { start: CapsuleView | null; today: string; me: Me; onClose: () => void; onSaved: (saved: CapsuleView) => void }) {
  const { t, i18n } = useTranslation()
  const [people, setPeople] = useState<Person[] | null>(null)
  const [to, setTo] = useState<number[]>(start?.to?.map((person) => person.id) ?? [me.id])
  const [opens, setOpens] = useState(start?.opens_on ?? addDays(today, 365))
  const [title, setTitle] = useState(start?.title ?? '')
  const [body, setBody] = useState(start?.text ?? '')
  const [photo, setPhoto] = useState<PhotoChoice>(start?.photo ? { kind: 'keep' } : { kind: 'none' })
  const [uploading, setUploading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [clientId] = useState(newId)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    sharingApi.people().then(
      (list) => alive && setPeople(list),
      (error) => alive && setProblem(error instanceof ApiError ? error.code : 'internal_error'),
    )
    return () => {
      alive = false
    }
  }, [])
  useEffect(() => () => (photo.kind === 'new' ? URL.revokeObjectURL(photo.url) : undefined), [photo])

  const everyone = useMemo<Person[]>(() => [{ id: me.id, name: me.name, display_name: me.display_name, avatar: me.avatar }, ...(people ?? [])], [me, people])
  const chosen = everyone.filter((person) => to.includes(person.id))
  const others = chosen.filter((person) => person.id !== me.id)
  const onlyMe = to.length === 1 && to[0] === me.id
  const otherNames = listOf(i18n.language, others.map(nameOf))
  const latest = yearsLater(today, 50)
  const inFuture = daysBetween(today, opens) > 0 && opens <= latest
  const ok = to.length > 0 && title.trim() !== '' && body.trim() !== '' && inFuture && !uploading && !busy
  const toggle = (id: number) => setTo(to.includes(id) ? to.filter((other) => other !== id) : [...to, id])
  const year = Number(today.slice(0, 4))
  const silvester = today.slice(5) === '12-31' ? `${year + 1}-12-31` : `${year}-12-31`
  const quick = [
    { label: t('capsules.inAYear'), date: addDays(today, 365) },
    { label: t('capsules.inFiveYears'), date: addDays(today, 1826) },
    { label: t('capsules.newYearsEve'), date: silvester },
  ]

  const pick = async (picked: File) => {
    setUploading(true)
    setProblem(null)
    try {
      const kept = await capsulesApi.upload(picked, newId())
      setPhoto({ kind: 'new', id: kept.id, url: URL.createObjectURL(picked) })
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setUploading(false)
    }
  }

  const submit = async () => {
    if (!ok) return
    setBusy(true)
    setProblem(null)
    const draft: CapsuleDraft = { to, opens_on: opens, title, text: body }
    if (photo.kind === 'new') draft.photo = photo.id
    else if (photo.kind === 'none' && (!start || start.photo)) draft.photo = null
    try {
      const saved = start ? await capsulesApi.change(start.id, start.revision ?? 0, draft) : await capsulesApi.create(clientId, draft)
      onSaved(saved)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
      setBusy(false)
    }
  }

  const shownPhoto = photo.kind === 'new' ? photo.url : photo.kind === 'keep' && start ? capsulePhotoUrl(start.id, true) : null

  return (
    <Dialog title={start ? t('capsules.composeChange') : t('capsules.compose')} onClose={onClose} wide>
      <div className="space-y-5">
        <div>
          <p className="mb-2 text-sm font-bold text-ink-2">{t('capsules.forWhom')}</p>
          <div className="flex flex-wrap gap-2">
            {everyone.map((person) => {
              const on = to.includes(person.id)
              return (
                <button
                  key={person.id}
                  type="button"
                  onClick={() => toggle(person.id)}
                  aria-pressed={on}
                  className={`inline-flex max-w-full items-center gap-2 rounded-full border py-1 pr-3.5 pl-1 text-sm font-semibold transition ${on ? 'border-transparent bg-accent text-accent-ink' : 'border-line bg-sheet text-ink-2 hover:border-accent'}`}
                >
                  <Avatar person={person} size={26} /> <span className="truncate">{person.id === me.id ? t('capsules.me') : nameOf(person)}</span>
                </button>
              )
            })}
          </div>
        </div>
        <div>
          <p className="mb-2 text-sm font-bold text-ink-2">{t('capsules.when')}</p>
          <div className="flex flex-wrap items-center gap-2">
            {quick.map((entry) => (
              <button key={entry.label} type="button" onClick={() => setOpens(entry.date)} aria-pressed={opens === entry.date} className={`rounded-full px-3.5 py-1.5 text-sm font-semibold transition ${opens === entry.date ? 'bg-accent text-accent-ink' : 'bg-sheet-2 text-ink-2 hover:bg-accent-soft'}`}>
                {entry.label}
              </button>
            ))}
            <input type="date" value={opens} min={addDays(today, 1)} max={latest} onChange={(event) => setOpens(event.target.value)} aria-label={t('capsules.dateLabel')} className="rounded-full border border-line bg-sheet px-3.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none" />
          </div>
          <p className="mt-2 text-sm text-muted">{inFuture ? t('capsules.whenLine', { date: longDate(opens, i18n.language, true), until: untilText(t, today, opens) }) : t('capsules.pickFuture')}</p>
        </div>
        <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder={t('capsules.titlePlaceholder')} aria-label={t('capsules.titleLabel')} className="w-full border-b border-line bg-transparent pb-2 font-display text-2xl font-semibold text-ink placeholder:text-muted/70 focus:border-accent focus:outline-none" />
        <textarea
          value={body}
          maxLength={50_000}
          onChange={(event) => setBody(event.target.value)}
          rows={8}
          aria-label={t('capsules.textLabel')}
          placeholder={onlyMe || to.length === 0 ? t('capsules.textPlaceholderSelf') : t('capsules.textPlaceholderOthers', { names: otherNames || t('capsules.yourself') })}
          className="w-full resize-y rounded-xl border border-line bg-sheet px-4 py-3 font-serif text-[1.05rem] leading-relaxed text-ink placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-3">
          {shownPhoto ? (
            <button type="button" onClick={() => setPhoto({ kind: 'none' })} title={t('capsules.removePhoto')} aria-label={t('capsules.removePhoto')} className="overflow-hidden rounded-lg">
              <img src={shownPhoto} alt="" className="h-16 w-24 object-cover" />
            </button>
          ) : (
            <button type="button" className={SOFT_SMALL} onClick={() => file.current?.click()} disabled={uploading}>
              <ImagePlus size={15} aria-hidden /> {t('capsules.addPhoto')}
            </button>
          )}
          <input
            ref={file}
            type="file"
            accept={PHOTO_ACCEPT}
            className="hidden"
            aria-label={t('capsules.addPhoto')}
            onChange={(event) => {
              const picked = event.target.files?.[0]
              event.target.value = ''
              if (picked) void pick(picked)
            }}
          />
        </div>
        <p className="text-sm text-ink-2" data-hint>
          {onlyMe || others.length === 0 ? t('capsules.hintSelf') : t('capsules.hintOthers', { count: others.length, names: otherNames })} {t('capsules.hintPush')}
        </p>
        {problem && <p className="text-sm text-bad">{errorText(problem)}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={GHOST} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className={PRIMARY} disabled={!ok} onClick={() => void submit()}>
            <Lock size={16} aria-hidden /> {t('capsules.close')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
