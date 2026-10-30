/**
 * Adding to the attachments of a day: the button "Anhängen" with its menu (photos for the day, video, voice recording,
 * PDF, link), and what each entry opens. Video and PDF open the device's file picker (a phone offers its camera for a
 * video), then the upload with its progress, which can be stopped and is tried again after a dropped connection with
 * the same id. A video in HEVC is asked about right after it arrived, when the server offers to convert it. A voice
 * recording is made in the browser (`lib/recorder.ts`); a link is only an address and a title, nexdiary never opens it.
 *
 * `resolveDate` gives the day an addition belongs to at the moment it is sent (after midnight on "Today", the day the
 * person chose for the notes of the night); null stops it.
 */
import { FileText, Film, Images, ImagePlus, Link2, Loader2, Mic, Paperclip, Square, Wand2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, attachmentsApi, type Attachment, type AttachmentLimits } from '../api/client'
import { bars, clock, linkOk } from '../lib/attachments'
import { ACCEPT, cleanName, knownLimits, loadLimits, nameOfFile, tooLarge, uploadAttachment, type FileKind, type Upload } from '../lib/attachmentUpload'
import { timeOf } from '../lib/dates'
import { errorText } from '../lib/errors'
import { newId } from '../lib/ids'
import { missing, MAX_SECONDS, Recording } from '../lib/recorder'
import { PHOTO_ACCEPT } from '../lib/upload'
import { useAuth } from '../state/auth'
import { Dialog } from './Dialog'

export type ResolveDate = () => Promise<string | null>

const PRIMARY = 'inline-flex h-10 items-center justify-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink transition hover:brightness-105 disabled:opacity-50'
const GHOST = 'inline-flex h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold text-ink-2 transition hover:bg-sheet-2 disabled:opacity-50'
const SOFT_SMALL = 'inline-flex h-8 items-center justify-center gap-2 rounded-full bg-accent-soft px-3.5 text-sm font-semibold text-accent transition hover:brightness-[0.98]'
const FIELD = 'mt-1 h-11 w-full rounded-xl border bg-sheet px-3.5 text-ink outline-none focus:border-accent'
const ITEM = 'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold text-ink-2 hover:bg-sheet-2 hover:text-ink focus:bg-sheet-2 focus:outline-none'

/** The limits as the page knows them, asked of the server once. */
// eslint-disable-next-line react-refresh/only-export-components
export function useAttachmentLimits(): Partial<AttachmentLimits> {
  const [limits, setLimits] = useState<Partial<AttachmentLimits>>(knownLimits)
  useEffect(() => {
    let alive = true
    void loadLimits().then((found) => alive && setLimits({ ...found }))
    return () => {
      alive = false
    }
  }, [])
  return limits
}

/** The sentence for a refusal; "too large" without a number when the server named none. */
function problemText(code: string, values: Record<string, unknown>, t: (key: string, values?: Record<string, unknown>) => string): string {
  if (code === 'attachment_too_large' && typeof values.max_mb !== 'number') return t('attachments.tooLarge')
  // The brake is the one of photos; its sentence there speaks of photos.
  if (code === 'too_many_uploads') return t('attachments.tooManyUploads')
  return errorText(code, values)
}

type Problem = { code: string; values: Record<string, unknown> }
const problemOf = (error: unknown): Problem => (error instanceof ApiError ? { code: error.code, values: error.values } : { code: 'internal_error', values: {} })

type Step = null | 'menu' | 'record' | 'link'
type Sending = { kind: FileKind; files: { file: Blob; name: string }[] }

/** The button "Anhängen" and its menu. `onPhotos` takes photos for the day (several at once), `onImmichPhotos` opens
 * the own Immich; without ffmpeg on the server, video and recording are not offered. */
export function AttachButton({
  date,
  resolveDate,
  onAdded,
  onPhotos,
  onImmichPhotos,
  compact = false,
}: {
  date: string
  resolveDate?: ResolveDate
  onAdded: (attachment: Attachment) => void
  onPhotos?: (files: File[]) => void
  onImmichPhotos?: () => void
  compact?: boolean
}) {
  const { t } = useTranslation()
  const limits = useAttachmentLimits()
  const [step, setStep] = useState<Step>(null)
  const [sending, setSending] = useState<Sending | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const video = useRef<HTMLInputElement>(null)
  const pdf = useRef<HTMLInputElement>(null)
  const photos = useRef<HTMLInputElement>(null)
  const media = limits.ffmpeg !== false

  useEffect(() => {
    if (step !== 'menu') return
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setStep(null)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setStep(null)
        opener.current?.focus()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
        const at = items.indexOf(document.activeElement as HTMLElement)
        const next = items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]
        if (next) {
          event.preventDefault()
          next.focus()
        }
      }
    }
    document.addEventListener('pointerdown', away)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', key, true)
    }
  }, [step])

  const close = useCallback(() => setStep(null), [])
  const doneSending = useCallback(() => setSending(null), [])
  const pick = (kind: FileKind, list: FileList | null, fallback: string) => {
    const files = [...(list ?? [])].map((file) => ({ file, name: nameOfFile(file, kind, fallback) }))
    if (files.length) setSending({ kind, files })
  }
  const choose = (input: React.RefObject<HTMLInputElement | null>) => {
    setStep(null)
    input.current?.click()
  }

  return (
    <div ref={box} className="relative">
      {compact ? (
        <button ref={opener} type="button" onClick={() => setStep(step === 'menu' ? null : 'menu')} className="rounded-full p-2.5 text-muted hover:bg-sheet-2 hover:text-accent" aria-label={t('attachments.attach')} aria-haspopup="menu" aria-expanded={step === 'menu'}>
          <Paperclip size={20} aria-hidden />
        </button>
      ) : (
        <button ref={opener} type="button" onClick={() => setStep(step === 'menu' ? null : 'menu')} className={SOFT_SMALL} aria-haspopup="menu" aria-expanded={step === 'menu'} data-attach>
          <Paperclip size={15} aria-hidden /> {t('attachments.attach')}
        </button>
      )}
      {step === 'menu' && (
        <div role="menu" aria-label={t('attachments.attach')} className={`card rise absolute z-40 w-60 p-1.5 ${compact ? 'bottom-full left-0 mb-2' : 'top-full right-0 mt-2'}`} data-attach-menu>
          {onPhotos && (
            <button type="button" role="menuitem" className={ITEM} onClick={() => choose(photos)}>
              <ImagePlus size={17} aria-hidden /> {t('attachments.menu.photos')}
            </button>
          )}
          {onImmichPhotos && (
            <button
              type="button"
              role="menuitem"
              className={ITEM}
              onClick={() => {
                setStep(null)
                onImmichPhotos()
              }}
            >
              <Images size={17} aria-hidden /> {t('attachments.menu.immich')}
            </button>
          )}
          {media && (
            <button type="button" role="menuitem" className={ITEM} onClick={() => choose(video)}>
              <Film size={17} aria-hidden /> {t('attachments.menu.video')}
            </button>
          )}
          {media && (
            <button type="button" role="menuitem" className={ITEM} onClick={() => setStep('record')}>
              <Mic size={17} aria-hidden /> {t('attachments.menu.record')}
            </button>
          )}
          <button type="button" role="menuitem" className={ITEM} onClick={() => choose(pdf)}>
            <FileText size={17} aria-hidden /> {t('attachments.menu.pdf')}
          </button>
          <button type="button" role="menuitem" className={ITEM} onClick={() => setStep('link')}>
            <Link2 size={17} aria-hidden /> {t('attachments.menu.link')}
          </button>
        </div>
      )}
      <input
        ref={video}
        type="file"
        accept={ACCEPT.video}
        multiple
        className="hidden"
        aria-label={t('attachments.menu.video')}
        onChange={(event) => {
          pick('video', event.target.files, t('attachments.kind.video'))
          event.target.value = ''
        }}
        data-video-input
      />
      <input
        ref={pdf}
        type="file"
        accept={ACCEPT.pdf}
        multiple
        className="hidden"
        aria-label={t('attachments.menu.pdf')}
        onChange={(event) => {
          pick('pdf', event.target.files, t('attachments.kind.pdf'))
          event.target.value = ''
        }}
        data-pdf-input
      />
      {onPhotos && (
        <input
          ref={photos}
          type="file"
          accept={PHOTO_ACCEPT}
          multiple
          className="hidden"
          aria-label={t('attachments.menu.photos')}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ''
            if (files.length) onPhotos(files)
          }}
          data-photos-input
        />
      )}
      {sending && <UploadDialog kind={sending.kind} files={sending.files} date={date} resolveDate={resolveDate} onAdded={onAdded} onClose={doneSending} />}
      {step === 'record' && <RecordDialog date={date} resolveDate={resolveDate} onAdded={onAdded} onClose={close} onPickFile={(files) => (setStep(null), pick('audio', files, t('attachments.kind.audio')))} />}
      {step === 'link' && <LinkDialog date={date} resolveDate={resolveDate} onAdded={onAdded} onClose={close} />}
    </div>
  )
}

/** The microphone on its own, for the field on "Today" and the quick note. Not there without ffmpeg on the server. */
export function RecordButton({ date, resolveDate, onAdded, className = '', size = 21 }: { date: string; resolveDate?: ResolveDate; onAdded: (attachment: Attachment) => void; className?: string; size?: number }) {
  const { t } = useTranslation()
  const limits = useAttachmentLimits()
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState<Sending | null>(null)
  const close = useCallback(() => setOpen(false), [])
  const doneSending = useCallback(() => setSending(null), [])
  if (limits.ffmpeg === false) return null
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className} aria-label={t('attachments.record.button')} data-record>
        <Mic size={size} aria-hidden />
      </button>
      {open && (
        <RecordDialog
          date={date}
          resolveDate={resolveDate}
          onAdded={onAdded}
          onClose={close}
          onPickFile={(list) => {
            setOpen(false)
            const files = [...(list ?? [])].map((file) => ({ file, name: nameOfFile(file, 'audio', t('attachments.kind.audio')) }))
            if (files.length) setSending({ kind: 'audio', files })
          }}
        />
      )}
      {sending && <UploadDialog kind="audio" files={sending.files} date={date} resolveDate={resolveDate} onAdded={onAdded} onClose={doneSending} />}
    </>
  )
}

// --- Uploading a file --------------------------------------------------------------------------------------------------

/** The upload of one or more files of a kind, one after the other, with the progress of each; then, for each video in
 * HEVC the server offers to convert, the question. */
export function UploadDialog({
  kind,
  files,
  date,
  resolveDate,
  onAdded,
  onClose,
}: {
  kind: FileKind
  files: { file: Blob; name: string }[]
  date: string
  resolveDate?: ResolveDate
  onAdded: (attachment: Attachment) => void
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const limits = useAttachmentLimits()
  const [index, setIndex] = useState(0)
  const [progress, setProgress] = useState(0)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [asking, setAsking] = useState<Attachment[]>([])
  const [finished, setFinished] = useState(false)
  /** The upload under way; its id stays for a second try by hand. */
  const current = useRef<{ upload: Upload | null; uploadId: string | null; index: number }>({ upload: null, uploadId: null, index: -1 })
  const day = useRef<string | null | undefined>(undefined)
  const hevc = useRef<Attachment[]>([])
  const [round, setRound] = useState(0)
  // What the parent hands in may change on every render; the upload under way must not start again for it.
  const added = useRef(onAdded)
  const leave = useRef(onClose)
  const resolve = useRef<ResolveDate>(resolveDate ?? (async () => date))
  useEffect(() => {
    added.current = onAdded
    leave.current = onClose
    resolve.current = resolveDate ?? (async () => date)
  })

  useEffect(() => {
    if (finished || index >= files.length) return
    const item = files[index]
    let alive = true
    void (async () => {
      setProblem(null)
      setProgress(0)
      const max = tooLarge(item.file, kind)
      if (max !== null) {
        setProblem({ code: 'attachment_too_large', values: { max_mb: max } })
        return
      }
      if (day.current === undefined) day.current = await resolve.current()
      if (!alive) return
      if (!day.current) {
        leave.current()
        return
      }
      const again = current.current.index === index ? current.current.uploadId : null
      const upload = uploadAttachment({ file: item.file, kind, name: item.name, date: day.current, ...(again ? { uploadId: again } : {}), onProgress: (fraction) => alive && setProgress(fraction) })
      current.current = { upload, uploadId: upload.uploadId, index }
      try {
        const attachment = await upload.done
        if (!alive) return
        added.current(attachment)
        if (attachment.kind === 'video' && attachment.codec === 'hevc' && attachment.can_convert) hevc.current = [...hevc.current, attachment]
        current.current = { upload: null, uploadId: null, index: -1 }
        if (index + 1 < files.length) setIndex(index + 1)
        else {
          setFinished(true)
          if (hevc.current.length) setAsking(hevc.current)
          else leave.current()
        }
      } catch (error) {
        if (!alive) return
        const found = problemOf(error)
        if (found.code !== 'aborted') setProblem(found)
      }
    })()
    return () => {
      alive = false
      // A run left behind (the dialog closed, or the effect runs anew): its upload stops; a new run sends the same file
      // with the same id.
      if (current.current.index === index) current.current.upload?.abort()
    }
    // `round` starts the same file again (by hand, with the same id).
  }, [index, round, files, kind, finished])

  if (asking.length > 0)
    return (
      <HevcQuestion
        key={asking[0].id}
        attachment={asking[0]}
        onAdded={onAdded}
        onDone={() => {
          const rest = asking.slice(1)
          if (rest.length) setAsking(rest)
          else onClose()
        }}
      />
    )

  const item = files[Math.min(index, files.length - 1)]
  const title = kind === 'video' ? t('attachments.upload.videoTitle') : kind === 'pdf' ? t('attachments.upload.pdfTitle') : t('attachments.upload.audioTitle')
  const max = kind === 'video' ? limits.video_max_mb : limits.other_max_mb
  const retry = problem && ['network', 'upload_stalled', 'internal_error', 'busy', 'too_many_uploads'].includes(problem.code)
  const percent = Math.round(progress * 100)
  return (
    <Dialog title={title} onClose={onClose} above>
      <div className="py-2" data-upload>
        <p className="truncate text-sm font-semibold">{item?.name}</p>
        {files.length > 1 && <p className="text-xs text-muted">{t('attachments.upload.of', { n: index + 1, total: files.length })}</p>}
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-sheet-2" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
        </div>
        {problem ? (
          <p role="alert" className="mt-3 rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad" data-upload-problem={problem.code}>
            {problemText(problem.code, problem.values, t)}
          </p>
        ) : (
          <p className="mt-2 text-xs text-muted">{kind === 'video' ? t('attachments.upload.videoHint') : t('attachments.upload.hint')}</p>
        )}
        {typeof max === 'number' && kind !== 'audio' && (
          <p className="mt-4 text-xs text-muted">{t(kind === 'video' ? 'attachments.upload.limitVideo' : 'attachments.upload.limitPdf', { max: new Intl.NumberFormat(i18n.language).format(max) })}</p>
        )}
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" className={GHOST} onClick={onClose}>
          {problem ? t('common.close') : t('common.cancel')}
        </button>
        {retry && (
          <button type="button" className={PRIMARY} onClick={() => setRound((value) => value + 1)}>
            {t('attachments.upload.again')}
          </button>
        )}
      </div>
    </Dialog>
  )
}

/** Right after an HEVC video arrived: convert it into H.264, so that it plays everywhere? */
function HevcQuestion({ attachment, onAdded, onDone }: { attachment: Attachment; onAdded: (attachment: Attachment) => void; onDone: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const convert = async () => {
    if (busy) return
    setBusy(true)
    try {
      onAdded(await attachmentsApi.convert(attachment.id))
      onDone()
    } catch (error) {
      setProblem(problemOf(error))
      setBusy(false)
    }
  }
  return (
    <Dialog title={t('attachments.hevc.title')} onClose={onDone} above>
      <div data-hevc-question>
        <p className="text-sm leading-relaxed text-ink-2">{t('attachments.hevc.text', { name: attachment.name })}</p>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">{t('attachments.hevc.time')}</p>
        {problem && (
          <p role="alert" className="mt-3 text-sm text-bad">
            {errorText(problem.code, problem.values)}
          </p>
        )}
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className={GHOST} onClick={onDone}>
            {t('attachments.hevc.keep')}
          </button>
          <button type="button" className={PRIMARY} onClick={() => void convert()} disabled={busy}>
            <Wand2 size={16} aria-hidden /> {t('attachments.hevc.convert')}
          </button>
        </div>
        <p className="mt-4 text-xs text-muted">{t('attachments.hevc.later')}</p>
      </div>
    </Dialog>
  )
}

// --- A voice recording ---------------------------------------------------------------------------------------------------

type RecordState = 'ready' | 'starting' | 'on' | 'done' | 'sending'
type RecordProblem = 'insecure' | 'unsupported' | 'denied' | 'no_microphone' | null

/** Recording with the microphone: start, the time and a level while it runs, stop; then a name and "Behalten", which
 * uploads it. `now` is the clock (for the tests). */
export function RecordDialog({
  date,
  resolveDate,
  onAdded,
  onClose,
  onPickFile,
  now = Date.now,
}: {
  date: string
  resolveDate?: ResolveDate
  onAdded: (attachment: Attachment) => void
  onClose: () => void
  onPickFile?: (files: FileList | null) => void
  now?: () => number
}) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [state, setState] = useState<RecordState>('ready')
  const [secs, setSecs] = useState(0)
  const [tick, setTick] = useState(0)
  const [blocked, setBlocked] = useState<RecordProblem>(() => missing())
  const [limitHit, setLimitHit] = useState(false)
  const [name, setName] = useState('')
  const [progress, setProgress] = useState(0)
  const [problem, setProblem] = useState<Problem | null>(null)
  const recording = useRef<Recording | null>(null)
  const result = useRef<Blob | null>(null)
  const upload = useRef<Upload | null>(null)
  const uploadId = useRef(newId())
  const levels = useRef<number[] | null>(null)
  const file = useRef<HTMLInputElement>(null)

  const stop = useCallback(async () => {
    const found = await recording.current?.stop()
    result.current = found?.blob ?? null
    if (found) setSecs(found.seconds)
    setState('done')
  }, [])

  useEffect(() => {
    if (state !== 'on') return
    const source = recording.current?.source
    let analyser: AnalyserNode | null = null
    let context: AudioContext | null = null
    const Context = (window as { AudioContext?: typeof AudioContext }).AudioContext
    if (source && Context) {
      try {
        context = new Context()
        analyser = context.createAnalyser()
        analyser.fftSize = 256
        context.createMediaStreamSource(source).connect(analyser)
        levels.current = Array(28).fill(0.15)
      } catch {
        analyser = null
      }
    }
    const sample = new Uint8Array(128)
    const timer = window.setInterval(() => {
      const seconds = recording.current?.tick() ?? 0
      setSecs(seconds)
      if (analyser && levels.current) {
        analyser.getByteTimeDomainData(sample)
        let peak = 0
        for (const value of sample) peak = Math.max(peak, Math.abs(value - 128) / 128)
        levels.current = [...levels.current.slice(1), Math.max(0.15, Math.min(1, peak * 2.2))]
      }
      setTick((value) => value + 1)
    }, 150)
    return () => {
      window.clearInterval(timer)
      void context?.close().catch(() => undefined)
      levels.current = null
    }
  }, [state])

  // Leaving frees the microphone and stops an upload under way.
  useEffect(
    () => () => {
      recording.current?.cancel()
      upload.current?.abort()
    },
    [],
  )

  const start = async () => {
    setProblem(null)
    setLimitHit(false)
    const take = new Recording({ now })
    take.onLimit = () => {
      setLimitHit(true)
      void stop()
    }
    recording.current = take
    setState('starting')
    try {
      await take.start()
      // Closed while the browser asked: nothing records, nothing more to show.
      if (take.state !== 'recording' || recording.current !== take) return
      setName(t('attachments.record.defaultName', { time: timeOf(new Date(now()).toISOString(), me?.profile?.timezone) }))
      setSecs(0)
      setState('on')
    } catch (error) {
      const why = error instanceof Error ? error.message : ''
      setBlocked(why === 'insecure' || why === 'unsupported' || why === 'no_microphone' ? why : 'denied')
      setState('ready')
    }
  }

  const keep = async () => {
    const blob = result.current
    if (!blob || state === 'sending') return
    setState('sending')
    setProblem(null)
    setProgress(0)
    const day = resolveDate ? await resolveDate() : date
    if (!day) {
      setState('done')
      return
    }
    const sending = uploadAttachment({ file: blob, kind: 'audio', name: cleanName(name) || t('attachments.kind.audio'), date: day, uploadId: uploadId.current, onProgress: setProgress })
    upload.current = sending
    try {
      onAdded(await sending.done)
      onClose()
    } catch (error) {
      const found = problemOf(error)
      if (found.code === 'aborted') return
      setProblem(found)
      setState('done')
    }
  }

  const discard = () => {
    recording.current?.cancel()
    result.current = null
    uploadId.current = newId()
    setSecs(0)
    setLimitHit(false)
    setProblem(null)
    setState('ready')
  }

  const live = state === 'on' ? (levels.current ?? bars(`live${tick}`, 28)) : bars('still', 28)
  return (
    <Dialog title={t('attachments.record.title')} onClose={onClose} above>
      <div className="flex flex-col items-center py-2" data-recorder={state}>
        <div className="flex h-14 w-full items-center justify-center gap-[3px]" aria-hidden>
          {live.map((height, index) => (
            <span key={index} className={`w-1.5 rounded-full transition-all ${state === 'on' ? 'bg-accent' : 'bg-line'}`} style={{ height: `${(state === 'on' ? height : 0.15) * 100}%` }} />
          ))}
        </div>
        <p className="mt-3 font-display text-4xl font-semibold tabular-nums" data-record-time>
          {clock(secs)}
        </p>
        {(state === 'ready' || state === 'starting') && (
          <>
            {blocked ? (
              <p role="alert" className="mt-5 rounded-xl bg-sheet-2 px-4 py-3 text-center text-sm text-ink-2" data-record-blocked={blocked}>
                {t(`attachments.record.${blocked === 'no_microphone' ? 'noMicrophone' : blocked}`)}
              </p>
            ) : (
              <>
                <button type="button" onClick={() => void start()} disabled={state === 'starting'} className="mt-5 flex h-16 w-16 items-center justify-center rounded-full bg-accent text-accent-ink shadow-soft disabled:opacity-60" aria-label={t('attachments.record.start')}>
                  {state === 'starting' ? <Loader2 size={26} className="animate-spin" aria-hidden /> : <Mic size={28} aria-hidden />}
                </button>
                <p className="mt-4 text-center text-xs text-muted">{t('attachments.record.hint', { minutes: MAX_SECONDS / 60 })}</p>
              </>
            )}
            {onPickFile && (
              <>
                <button type="button" onClick={() => file.current?.click()} className="mt-3 text-sm font-semibold text-accent hover:underline">
                  {t('attachments.record.pickFile')}
                </button>
                <input
                  ref={file}
                  type="file"
                  accept={ACCEPT.audio}
                  className="hidden"
                  aria-label={t('attachments.record.pickFile')}
                  onChange={(event) => {
                    const picked = event.target.files
                    onPickFile(picked && picked.length ? picked : null)
                    event.target.value = ''
                  }}
                  data-audio-input
                />
              </>
            )}
          </>
        )}
        {state === 'on' && (
          <>
            <button type="button" onClick={() => void stop()} className="mt-5 flex h-16 w-16 items-center justify-center rounded-full bg-red-600 text-white shadow-soft" aria-label={t('attachments.record.stop')}>
              <Square size={24} fill="currentColor" aria-hidden />
            </button>
            <p className="mt-4 text-xs font-semibold text-red-600" role="status">
              ● {t('attachments.record.on')}
            </p>
          </>
        )}
        {(state === 'done' || state === 'sending') && (
          <div className="mt-5 w-full">
            {limitHit && (
              <p role="status" className="mb-3 rounded-xl bg-sheet-2 px-4 py-2.5 text-sm text-ink-2" data-record-limit>
                {t('attachments.record.limit')}
              </p>
            )}
            <label className="block text-sm">
              <span className="font-semibold">{t('attachments.record.name')}</span>
              <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} className={`${FIELD} border-line`} disabled={state === 'sending'} />
            </label>
            {state === 'sending' && (
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-sheet-2" role="progressbar" aria-label={t('attachments.upload.audioTitle')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            )}
            {problem && (
              <p role="alert" className="mt-3 rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
                {problemText(problem.code, problem.values, t)}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className={GHOST} onClick={discard} disabled={state === 'sending'}>
                {t('attachments.record.discard')}
              </button>
              <button type="button" className={PRIMARY} onClick={() => void keep()} disabled={state === 'sending' || !result.current}>
                {state === 'sending' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null} {t('attachments.record.keep')}
              </button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  )
}

// --- A link --------------------------------------------------------------------------------------------------------------

export function LinkDialog({ date, resolveDate, onAdded, onClose }: { date: string; resolveDate?: ResolveDate; onAdded: (attachment: Attachment) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [uploadId] = useState(newId)
  const ok = linkOk(url)
  const add = async () => {
    setTried(true)
    if (!ok || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const day = resolveDate ? await resolveDate() : date
      if (!day) return
      onAdded(await attachmentsApi.link(day, url.trim(), title.trim() || null, uploadId))
      onClose()
    } catch (error) {
      setProblem(problemOf(error))
    } finally {
      setBusy(false)
    }
  }
  const invalid = (tried && !ok) || (problem?.code === 'invalid_input' && (problem.values.fields as unknown[] | undefined)?.includes('url'))
  return (
    <Dialog title={t('attachments.link.title')} onClose={onClose} above>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void add()
        }}
        className="space-y-4"
        noValidate
        data-link-form
      >
        <label className="block text-sm">
          <span className="font-semibold">{t('attachments.link.address')}</span>
          <input
            value={url}
            autoFocus
            type="url"
            inputMode="url"
            autoComplete="off"
            maxLength={2048}
            aria-invalid={invalid || undefined}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://…"
            className={`${FIELD} ${invalid ? 'border-red-400' : 'border-line'}`}
          />
          {invalid && <span className="mt-1 block text-xs text-red-600" data-link-invalid>{t('attachments.link.invalid')}</span>}
        </label>
        <label className="block text-sm">
          <span className="font-semibold">{t('attachments.link.titleLabel')}</span> <span className="text-muted">{t('attachments.link.optional')}</span>
          <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder={t('attachments.link.titlePlaceholder')} className={`${FIELD} border-line`} />
        </label>
        <p className="text-xs text-muted">{t('attachments.link.privacy')}</p>
        {problem && !invalid && (
          <p role="alert" className="text-sm text-bad">
            {errorText(problem.code, problem.values)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={GHOST} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className={PRIMARY} disabled={busy}>
            {t('attachments.link.add')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
