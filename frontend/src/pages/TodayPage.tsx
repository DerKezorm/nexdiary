/**
 * "Today", as the mock's `Today.tsx`, in the three layouts a person chooses under My account, Look: one page, two columns,
 * or like a chat. Notes are thrown down here, changed and deleted; the values of the day are rated.
 *
 * Photos are taken or picked with the camera button beside the field (they go with the next note) and under "Fotos
 * von heute"; "Den Tag aufschreiben" leads to the writing page, with the AI when the operator set one up and the person
 * did not switch it off ("Ausformulieren": the writing page asks for the suggestion, never on its own). The question of
 * the day stands under the field; its answer becomes a note with the question. With Immich connected, the photos taken
 * there today are suggested in "Fotos von heute" and copied only when chosen.
 *
 * Under the question of the day stands the family question for whoever joined (or, once, the quiet hint that others
 * take part); "Erst fragen lassen" lets the AI ask about the notes before it writes the day up, and "Heute nur kurz"
 * makes the page of today out of one sentence and the first value (`components/TodayExtras.tsx`).
 */
import { ArrowUp, Check, ImagePlus, Images, Loader2, MessageCircleQuestion, PenLine, Shuffle, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { immichApi, immichThumbUrl, photoUrl, type AiLength, type AiState, type ImmichEntry, type ImmichPhoto, type Note, type TodayData, type ValueDef } from '../api/client'
import { AutoDraftCard, CatchUpCard } from '../components/CatchUp'
import { Dialog } from '../components/Dialog'
import { ImmichPicker } from '../components/ImmichPicker'
import { LockedMark } from '../components/LockDay'
import { NightDialog, NightHint } from '../components/NightChoice'
import { NoteMenu } from '../components/NoteMenu'
import { useOwnPhotoViewer } from '../components/ownPhotoViewer'
import { useDeletePhotos } from '../components/PhotoDelete'
import { PhotoTile } from '../components/PhotoViews'
import { StreakBadges } from '../components/Streak'
import { FamilyHint, FamilyQuestion, FollowupDialog, ShortEntry } from '../components/TodayExtras'
import { Scale } from '../components/Scale'
import { TagPicker } from '../components/TagPicker'
import { longDate, timeOf } from '../lib/dates'
import { errorText } from '../lib/errors'
import { PHOTO_ACCEPT } from '../lib/upload'
import { PendingPhoto, usePendingPhoto } from '../components/PendingPhoto'
import { PhotoSourceButton } from '../components/PhotoSource'
import { aiHint } from '../lib/aiProviders'
import { useAiState } from '../state/ai'
import { useImmichDay } from '../state/immich'
import { useAuth } from '../state/auth'
import { useToday, type TodayState } from '../state/today'

/** The big view of a photo of today: it runs through all the photos of the day; a deleted one is gone from the page. */
function useTodayViewer(today: TodayState) {
  const viewOwn = useOwnPhotoViewer(() => void today.load())
  const photos = today.data?.photos ?? []
  return (id: string, opener: HTMLElement) =>
    viewOwn(
      photos.map((photo) => ({ id: photo.id })),
      Math.max(0, photos.findIndex((photo) => photo.id === id)),
      opener,
    )
}

/** Morning until eleven, the day until six, then the evening: the greeting of "Today". */
// eslint-disable-next-line react-refresh/only-export-components
export function greetingOf(hour: number): 'morning' | 'day' | 'evening' {
  return hour < 11 ? 'morning' : hour < 18 ? 'day' : 'evening'
}

export function TodayPage({ now }: { now?: Date }) {
  const today = useToday()
  const { me } = useAuth()
  const [drawer, setDrawer] = useState(false)
  const ai = useAiState()
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
        <Before today={today} />
        <div className="mb-3">
          <FinishCard today={today} ai={ai} now={now} />
        </div>
        <div className="flex-1 pb-4">
          <Bubbles today={today} />
          <div className="mt-4 space-y-4">
            <PromptCard today={today} />
            <FamilyHint today={today} />
            <FamilyQuestion today={today} />
          </div>
        </div>
        <div className="sticky bottom-[4.5rem] z-20 bg-gradient-to-t from-paper via-paper to-transparent pt-6 pb-3 lg:bottom-0">
          {problem}
          <Capture today={today} chat />
        </div>
        <NightDialog today={today} />
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
        <Before today={today} />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-4">
            <Capture today={today} />
            {problem}
            <PromptCard today={today} />
            <FamilyHint today={today} />
            <FamilyQuestion today={today} />
            <Timeline today={today} />
          </div>
          <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <FinishCard today={today} ai={ai} now={now} />
            <ValuesBlock today={today} />
            <PhotosBlock today={today} />
            <TagsBlock today={today} />
          </aside>
        </div>
        <NightDialog today={today} />
      </div>
    )

  return (
    <div className="page space-y-5 pb-28 lg:pb-12">
      <Header now={now} today={today} />
      <Before today={today} />
      <Capture today={today} />
      {problem}
      <PromptCard today={today} />
      <FamilyHint today={today} />
      <FamilyQuestion today={today} />
      <Timeline today={today} />
      <PhotosBlock today={today} />
      <ValuesBlock today={today} />
      <TagsBlock today={today} />
      <FinishCard today={today} ai={ai} now={now} />
      <NightDialog today={today} />
    </div>
  )
}

const PRIMARY = 'inline-flex h-11 items-center justify-center gap-2 rounded-full bg-accent px-5 text-[0.95rem] font-semibold text-accent-ink shadow-soft transition hover:brightness-105 disabled:pointer-events-none disabled:opacity-50'
const SOFT = 'inline-flex h-11 items-center justify-center gap-2 rounded-full bg-accent-soft px-5 text-[0.95rem] font-semibold text-accent transition hover:brightness-[0.98]'
const SMALL_PRIMARY = 'inline-flex h-8 items-center justify-center gap-2 rounded-full bg-accent px-3.5 text-sm font-semibold text-accent-ink shadow-soft transition hover:brightness-105 disabled:pointer-events-none disabled:opacity-50'
const SMALL_GHOST = 'inline-flex h-8 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold text-ink-2 transition hover:bg-sheet-2'

/** What stands above the notes: where the notes of this night go, a note that was just moved, whether the day is
 * locked, and the days that have notes and no page yet. */
function Before({ today }: { today: TodayState }) {
  const { t, i18n } = useTranslation()
  const data = today.data
  if (!data) return null
  const lines = [data.night?.active && data.night.choice !== null, today.moved, data.day?.locked, data.catch_up?.count].some(Boolean)
  if (!lines) return null
  return (
    <div className="mb-5 space-y-3" data-before>
      <NightHint today={today} />
      {today.moved && (
        <p role="status" className="flex items-center justify-between gap-3 rounded-xl bg-sheet-2 px-3.5 py-2 text-sm text-ink-2">
          <span>{t('today.moved', { day: longDate(today.moved, i18n.language) })}</span>
          <button type="button" onClick={today.clearMoved} className="rounded-full p-1 text-muted hover:text-ink" aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </p>
      )}
      {data.day?.locked && (
        <p className="flex items-center gap-2 rounded-xl bg-sheet-2 px-3.5 py-2 text-sm text-ink-2" role="status">
          <LockedMark /> {t('today.lockedDay')}
        </p>
      )}
      <AutoDraftCard data={data.catch_up} today={data.date} />
      <CatchUpCard data={data.catch_up} />
    </div>
  )
}

/** The question of the day, as the mock: a small push for days when nothing comes to mind. The same all day; "Andere
 * Frage" moves it on for today. The answer becomes a note with its question, and the next question comes. */
function PromptCard({ today }: { today: TodayState }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const question = today.data?.question
  if (!question) return null
  const answer = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    if (await today.addNote(text, null, question)) {
      setText('')
      setOpen(false)
    }
    setBusy(false)
  }
  return (
    <section className="rounded-[1.25rem] border border-dashed border-accent/40 bg-accent-soft/40 px-5 py-4" aria-label={t('today.promptTitle')}>
      <div className="flex items-start gap-3">
        <MessageCircleQuestion size={20} className="mt-0.5 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold tracking-wide text-accent uppercase">{t('today.promptTitle')}</p>
          <p className="mt-0.5 font-serif text-lg leading-snug text-ink" data-question>
            {question.text}
          </p>
          {open ? (
            <div className="mt-3">
              <textarea
                autoFocus
                rows={2}
                value={text}
                maxLength={5000}
                aria-label={t('today.promptLabel')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void answer()
                  }
                }}
                placeholder={t('today.promptPlaceholder')}
                className="w-full resize-none rounded-xl border border-line bg-sheet px-3 py-2 text-ink placeholder:text-muted focus:border-accent focus:outline-none"
              />
              <div className="mt-2 flex gap-2">
                <button type="button" className={SMALL_PRIMARY} onClick={() => void answer()} disabled={!text.trim() || busy}>
                  {t('today.add')}
                </button>
                <button type="button" className={SMALL_GHOST} onClick={() => setOpen(false)}>
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className={SMALL_PRIMARY} onClick={() => setOpen(true)}>
                {t('today.promptAnswer')}
              </button>
              <button type="button" className={SMALL_GHOST} onClick={() => void today.anotherQuestion()}>
                <Shuffle size={14} aria-hidden /> {t('today.promptOther')}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

/** "Den Tag aufschreiben", as the mock's finish card: "Ausformulieren" with the AI (short or long) and "Erst fragen
 * lassen" above "Selbst schreiben" when there is an AI for this person and notes to write from. A day that has a page
 * already keeps the button, for notes added later; the writing page asks before the AI writes over the saved page.
 * "Heute nur kurz" below, while the day has no page. */
function FinishCard({ today, ai, now }: { today: TodayState; ai: AiState | null; now?: Date }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [length, setLength] = useState<AiLength>('long')
  const [asking, setAsking] = useState(false)
  const [short, setShort] = useState(false)
  const data = today.data as TodayData
  const count = data.notes.length
  const written = Boolean(data.day?.text.trim())
  const aiOn = Boolean(ai?.available) && !data.day?.locked && data.notes.some((note) => note.text && !note.unreadable)
  const text = written ? t(aiOn ? 'write.finishExistingAi' : 'write.finishExisting') : count > 0 ? t('write.finishText', { count }) : t('write.finishNoNotes')
  const formulate = () => navigate(`/tag/${data.date}/schreiben`, { state: { formulate: length } })
  return (
    <>
      <section id="aufschreiben" className="card scroll-mt-6 overflow-hidden">
        <div className="bg-accent-soft/70 px-5 pt-5 pb-4">
          <h2 className="font-display text-lg font-semibold">{t('write.finishTitle')}</h2>
          <p className="mt-1 text-sm text-ink-2">{text}</p>
        </div>
        <div className="space-y-3 p-5">
          {aiOn && ai && (
            <>
              <div className="flex gap-2">
                {/* The press of the button: the writing page asks for the suggestion once, and forgets that it should. */}
                <button type="button" className={`${PRIMARY} flex-1`} onClick={formulate}>
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
              <button type="button" className={`${SOFT} w-full`} onClick={() => setAsking(true)}>
                <MessageCircleQuestion size={18} aria-hidden /> {t('followups.button')}
              </button>
              <p className="text-xs leading-relaxed text-muted">
                {aiHint(ai, t)} {t('write.aiPromise')}
              </p>
            </>
          )}
          <Link to={`/tag/${data.date}/schreiben`} className={`${aiOn ? SOFT : PRIMARY} w-full`}>
            <PenLine size={18} aria-hidden /> {written ? t('write.continue') : t('write.self')}
          </Link>
          {!written && !data.day?.locked && (
            <button type="button" onClick={() => setShort(true)} className="w-full pt-1 text-center text-sm font-semibold text-accent hover:underline">
              {t('short.link')}
            </button>
          )}
        </div>
      </section>
      {asking && (
        <FollowupDialog
          date={data.date}
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false)
            formulate()
          }}
        />
      )}
      {short && <ShortEntry today={today} now={now} onClose={() => setShort(false)} />}
    </>
  )
}

/** The photos of today, as the mock's photo strip: with Immich connected, the photos taken today there first, each
 * chosen with a tap (copied to the day only then) and put back with another; then the own uploads, each with its time,
 * and a tile to add one. Immich not answering leaves a quiet line; everything else goes on. */
function PhotosBlock({ today, bare = false }: { today: TodayState; bare?: boolean }) {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  // What was uploaded lately, not what was shot today: Immich often receives a phone's photos hours late.
  const immich = useImmichDay(today.data?.date, true, 'recent')
  const [choosing, setChoosing] = useState(false)
  const view = useTodayViewer(today)
  const { confirmDelete } = useDeletePhotos()
  // The photos of the day itself; a photo that came with a note stands with its note.
  const onNotes = new Set((today.data?.notes ?? []).map((note) => note.photo_id).filter(Boolean))
  const photos = (today.data?.photos ?? []).filter((photo) => !photo.on_note && !onNotes.has(photo.id))
  const kept = new Set(photos.map((photo) => photo.id))
  const suggested = immich.photos ?? []
  const chosen = (entry: ImmichPhoto) => Boolean(entry.photo_id && kept.has(entry.photo_id))
  // A photo taken from a tile stands as that tile, not a second time.
  const shownAsTile = new Set(suggested.filter(chosen).map((entry) => entry.photo_id))
  const own = photos.filter((photo) => !shownAsTile.has(photo.id))
  const add = async (picked: File) => {
    setBusy(true)
    await today.addPhoto(picked)
    setBusy(false)
  }
  const toggle = async (entry: ImmichPhoto) => {
    if (chosen(entry) && entry.photo_id) {
      immich.released(entry.photo_id)
      await today.deletePhoto(entry.photo_id)
      return
    }
    const photo = await immich.take(entry.id)
    if (photo) today.keepPhoto(photo)
  }
  const extra = immich.photos ? t('photos.fromImmich', { count: suggested.filter(chosen).length }) : t('photos.count', { count: photos.length })
  const zone = me?.profile?.timezone
  /** Any photo of the whole collection, copied for today. */
  const pickAny = async (entry: ImmichEntry) => {
    const day = today.data?.date
    if (!day) return
    const photo = await immichApi.take(entry.id, day, false, true)
    today.keepPhoto(photo)
  }
  return (
    <Block title={t('photos.title')} bare={bare} extra={<span className="text-sm text-muted">{extra}</span>}>
      {immich.connected && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs font-bold tracking-wide text-muted uppercase">{suggested.length > 0 ? t('photos.newInImmich') : ''}</span>
          <button type="button" onClick={() => setChoosing(true)} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-sheet-2 px-3 text-xs font-semibold text-ink-2 hover:bg-accent-soft hover:text-accent">
            <Images size={14} aria-hidden /> {t('photos.allImmich')}
          </button>
        </div>
      )}
      <div className="scroll-x -mx-1 flex gap-2.5 overflow-x-auto px-1 pb-1">
        {suggested.map((entry) => {
          const on = chosen(entry)
          const shot = new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: zone || undefined }).format(new Date(entry.taken_at))
          return (
            <div key={entry.id} className="w-32 shrink-0">
              <button
                type="button"
                onClick={() => void toggle(entry)}
                disabled={immich.taking !== null}
                className="relative block w-full overflow-hidden rounded-xl"
                aria-pressed={on}
                aria-label={`${t('photos.pick')} ${shot}`}
              >
                <img src={immichThumbUrl(entry.id)} alt="" className={`h-24 w-32 object-cover transition ${on ? '' : 'opacity-75 saturate-50'}`} draggable={false} />
                <span className={`absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white ${on ? 'bg-accent text-accent-ink' : 'bg-black/20'}`}>
                  {immich.taking === entry.id ? <Loader2 size={13} className="animate-spin text-white" aria-hidden /> : on && <Check size={14} strokeWidth={3} aria-hidden />}
                </span>
              </button>
              <span className="mt-1 block truncate text-[0.7rem] text-muted" data-shot>
                {shot}
              </span>
            </div>
          )
        })}
        {own.map((photo) => (
          <div key={photo.id} className="group relative shrink-0 overflow-hidden rounded-xl">
            <PhotoTile src={photoUrl(photo.id, true)} alt={t('photos.alt')} onOpen={(opener) => view(photo.id, opener)} className="block h-24 w-32" imageClassName="h-full w-full" />
            <span className="pointer-events-none absolute bottom-1 left-1.5 rounded bg-black/35 px-1 text-[0.68rem] font-bold text-white">{timeOf(photo.created_at, me?.profile?.timezone)}</span>
            <button
              type="button"
              onClick={() =>
                void confirmDelete([photo.id]).then((result) => {
                  if (result && result.deleted.length > 0) void today.load()
                })
              }
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
      {immich.away && <p className="mt-2 text-xs text-muted">{t('photos.immichAway')}</p>}
      {choosing && today.data && <ImmichPicker date={today.data.date} onClose={() => setChoosing(false)} onPick={pickAny} />}
      {immich.problem && (
        <p role="alert" className="mt-2 text-xs text-bad">
          {errorText(immich.problem.code, immich.problem.values)}
        </p>
      )}
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
    <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 pt-8 pb-6">
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
        {today.data && <StreakBadges data={today.data} />}
      </div>
    </header>
  )
}

function Capture({ today, chat = false }: { today: TodayState; chat?: boolean }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
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
      <PhotoSourceButton pending={pending} date={today.data?.date} className="rounded-full p-2.5 text-muted hover:bg-sheet-2 hover:text-accent" label={t('photos.attach')} />
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
  const view = useTodayViewer(today)
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
        {note.photo_id && <PhotoTile src={photoUrl(note.photo_id, true)} alt={t('photos.alt')} onOpen={(opener) => view(note.photo_id as string, opener)} className="mt-2 h-24 w-36 rounded-lg" imageClassName="h-full w-full" />}
      </div>
      <NoteMenu note={note} today={today} />
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
  const view = useTodayViewer(today)
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
            <NoteMenu note={note} today={today} className="self-center" />
            <button
              type="button"
              onClick={() => void today.deleteNote(note.id)}
              className="self-center rounded-full p-1.5 text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
              aria-label={t('today.deleteNote')}
            >
              <Trash2 size={14} />
            </button>
            <div className="max-w-[85%] rounded-[1.3rem] rounded-br-md bg-accent-soft px-4 py-2.5 text-ink">
              {note.photo_id && <PhotoTile src={photoUrl(note.photo_id, true)} alt={t('photos.alt')} onOpen={(opener) => view(note.photo_id as string, opener)} className="mb-2 block aspect-[16/10] w-56 max-w-full rounded-xl" imageClassName="h-full w-full" />}
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
