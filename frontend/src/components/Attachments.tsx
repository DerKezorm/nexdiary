/**
 * The attachments of a day (issue #2): videos, voice recordings, PDFs and links, beside the photos and never in the
 * text. Videos and PDFs stand as tiles (the still of a video with its length, the first page of a PDF drawn by pdf.js
 * once the tile is in sight), recordings and links as rows. A video opens in a player, a PDF in the reader
 * (`PdfViewer`, a chunk of its own), a link in a new tab without telling the other site where it came from.
 *
 * While a video waits or is converted the section asks the server how far it got, less often while nothing moves,
 * and stops as soon as none is converting any more, nothing moved for a long while, the server failed several times in
 * a row, or the page is left. A shared day shows the same, read only, through the share's routes.
 */
import { Download, ExternalLink, FileText, Film, Globe, Loader2, Pause, Play, Trash2, Wand2 } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, attachmentsApi, attachmentUrl, sharedAttachmentUrl, type Attachment } from '../api/client'
import { bars, clock, hostOf } from '../lib/attachments'
import { formatBytes } from '../lib/bytes'
import { forgetThumb, keepThumb, thumbOf } from '../lib/pdfThumbs'
import { errorText } from '../lib/errors'
import { withAttachment, type AttachmentUpdate } from '../state/attachments'
import { AttachButton, type ResolveDate } from './AttachMenu'
import { Dialog } from './Dialog'

const PdfViewer = lazy(() => import('./PdfViewer'))

/** Where the files come from: the own routes, or those of a day shared with me. */
export type AttachmentSource = { owner: number; date: string } | null
type Way = 'file' | 'download' | 'preview'

function urlOf(source: AttachmentSource, id: string, way: Way): string {
  return source ? sharedAttachmentUrl(source.owner, source.date, id, way) : attachmentUrl(id, way)
}

const busy = (item: Attachment) => item.status === 'queued' || item.status === 'converting'
const POLL_MS = 3000
/** The wait grows while nothing moves (3, 6, 12, 24, 30 seconds); after this many answers without a change, or this
 * many failed ones in a row, the page stops asking. A video that waits because the operator switched converting off
 * keeps waiting on the server; the page asks again when it is opened anew or another video is sent. */
const LONGEST_STEP = 10
const QUIET_ANSWERS = 12
const FAILED_ANSWERS = 4
/** What says whether a conversion moved: the state and progress of everything waiting or converting. */
const movement = (list: Attachment[]) =>
  list
    .filter(busy)
    .map((item) => `${item.id}:${item.status}:${item.progress ?? ''}`)
    .sort()
    .join(',')

/**
 * The section. `editable`: an own day that is not locked (adding, deleting, converting); `onChange` takes each change
 * of the list. `onPhotos` and `onImmichPhotos` add photos to the day from the same menu. Without `editable` and
 * without attachments it shows nothing at all.
 */
export function Attachments({
  date,
  items,
  onChange,
  editable = false,
  source = null,
  resolveDate,
  onPhotos,
  onImmichPhotos,
  card = false,
  pollMs = POLL_MS,
}: {
  date: string
  items: Attachment[]
  onChange?: AttachmentUpdate
  editable?: boolean
  source?: AttachmentSource
  resolveDate?: ResolveDate
  onPhotos?: (files: File[]) => void
  onImmichPhotos?: () => void
  card?: boolean
  pollMs?: number
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Attachment | null>(null)
  const [problem, setProblem] = useState<{ code: string; values: Record<string, unknown> } | null>(null)
  const change = useRef(onChange)
  useEffect(() => {
    change.current = onChange
  })
  const [gaveUpFor, setGaveUpFor] = useState<string | null>(null)
  // Something new from here (an upload, a conversion asked for): the asking starts again even for a video given up on.
  const add = useCallback((attachment: Attachment) => {
    setGaveUpFor(null)
    change.current?.((list) => withAttachment(list, attachment))
  }, [])
  const closeViewer = useCallback(() => setOpen(null), [])
  const closeRemove = useCallback(() => setRemoving(null), [])

  // Asked again while something of the day is waiting or converting, only then, less often while nothing moves, and
  // never once the page is left. Given up for a set of videos, it starts again for another one (sent to convert anew).
  const waiting = source ? '' : items.filter(busy).map((item) => item.id).sort().join(',')
  const asking = waiting !== '' && gaveUpFor !== waiting
  const day = items.find(busy)?.date ?? date
  const seen = useRef(items)
  useEffect(() => {
    seen.current = items
  })
  useEffect(() => {
    if (!asking) return
    let alive = true
    let ticks = 0
    let step = 1
    let quiet = 0
    let failed = 0
    let last = movement(seen.current)
    let open = false
    const timer = window.setInterval(() => {
      ticks += 1
      if (ticks < step || open) return
      ticks = 0
      open = true
      attachmentsApi.list(day).then(
        (fresh) => {
          open = false
          if (!alive) return
          failed = 0
          // Only what the page shows is brought up to date: an attachment added meanwhile stays, none appears unasked.
          const mine = new Set(seen.current.map((item) => item.id))
          const now = movement(fresh.filter((item) => mine.has(item.id)))
          change.current?.((list) => list.map((old) => fresh.find((item) => item.id === old.id) ?? old))
          if (now === last) {
            quiet += 1
            step = Math.min(step * 2, LONGEST_STEP)
          } else {
            quiet = 0
            step = 1
            last = now
          }
          if (quiet >= QUIET_ANSWERS) setGaveUpFor(waiting)
        },
        () => {
          open = false
          if (!alive) return
          failed += 1
          step = Math.min(step * 2, LONGEST_STEP)
          if (failed >= FAILED_ANSWERS) setGaveUpFor(waiting)
        },
      )
    }, pollMs)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [asking, waiting, day, pollMs])

  if (!editable && items.length === 0) return null
  const tiles = items.filter((item) => item.kind === 'video' || item.kind === 'pdf')
  const rows = items.filter((item) => item.kind === 'audio' || item.kind === 'link')
  const shown = items.find((item) => item.id === open) ?? null

  const remove = async () => {
    const gone = removing
    if (!gone) return
    try {
      await attachmentsApi.remove(gone.id)
      if (gone.kind === 'pdf') forgetThumb(urlOf(source, gone.id, 'file'))
      change.current?.((list) => list.filter((item) => item.id !== gone.id))
      setProblem(null)
      setRemoving(null)
    } catch (error) {
      setRemoving(null)
      setProblem(error instanceof ApiError ? { code: error.code, values: error.values } : { code: 'internal_error', values: {} })
    }
  }

  return (
    <section className={card ? 'card p-5' : ''} aria-label={t('attachments.title')} data-attachments>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className={card ? 'font-display text-lg font-semibold' : 'text-sm font-bold tracking-wide text-muted uppercase'}>
          {t('attachments.title')}
          {items.length > 0 && <span className="ml-1.5 font-normal text-muted">{items.length}</span>}
        </h2>
        {editable && <AttachButton date={date} resolveDate={resolveDate} onAdded={add} onPhotos={onPhotos} onImmichPhotos={onImmichPhotos} />}
      </div>
      {problem && (
        <p role="alert" className="mb-3 text-sm text-bad">
          {errorText(problem.code, problem.values)}
        </p>
      )}
      {items.length === 0 && <p className="rounded-xl border-2 border-dashed border-line px-4 py-4 text-sm text-muted">{t('attachments.empty')}</p>}
      {tiles.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {tiles.map((item) => (
            <Tile key={item.id} item={item} source={source} editable={editable} onOpen={() => setOpen(item.id)} onRemove={() => setRemoving(item)} />
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <ul className={`space-y-2 ${tiles.length ? 'mt-3' : ''}`}>
          {rows.map((item) => (
            <li key={item.id}>{item.kind === 'audio' ? <AudioRow item={item} source={source} editable={editable} onRemove={() => setRemoving(item)} /> : <LinkRow item={item} editable={editable} onRemove={() => setRemoving(item)} />}</li>
          ))}
        </ul>
      )}
      {shown?.kind === 'video' && <VideoViewer item={shown} source={source} editable={editable} onChanged={add} onClose={closeViewer} language={i18n.language} />}
      {shown?.kind === 'pdf' && (
        <Suspense fallback={null}>
          <PdfViewer title={shown.name} src={urlOf(source, shown.id, 'file')} download={urlOf(source, shown.id, 'download')} onClose={closeViewer} />
        </Suspense>
      )}
      {removing && (
        <Dialog title={t('attachments.removeTitle')} onClose={closeRemove} above>
          <p className="text-sm text-ink-2">{t('attachments.removeText', { name: removing.name })}</p>
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" onClick={closeRemove} className="inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-semibold text-ink-2 hover:bg-sheet-2">
              {t('attachments.keep')}
            </button>
            <button type="button" onClick={() => void remove()} className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink hover:brightness-105" data-remove-confirm>
              <Trash2 size={16} aria-hidden /> {t('attachments.removeConfirm')}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  )
}

function RemoveButton({ onClick, light = false }: { onClick: () => void; light?: boolean }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={`rounded-full p-1.5 ${light ? 'bg-black/40 text-white hover:bg-black/60' : 'text-muted hover:bg-sheet-2 hover:text-ink'}`}
      aria-label={t('attachments.remove')}
    >
      <Trash2 size={14} aria-hidden />
    </button>
  )
}

/** The first page of a PDF, small, drawn only once the tile comes into sight; kept for the tab in `lib/pdfThumbs.ts`. */
function PdfThumb({ src, size, onPages }: { src: string; size: number; onPages: (pages: number) => void }) {
  const holder = useRef<HTMLDivElement>(null)
  const [picture, setPicture] = useState<string | null>(() => thumbOf(src, size)?.picture ?? null)
  const told = useRef(onPages)
  useEffect(() => {
    told.current = onPages
  })
  useEffect(() => {
    const known = thumbOf(src, size)
    if (known) {
      told.current(known.pages)
      return
    }
    const element = holder.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    let alive = true
    let close: (() => void) | null = null
    const watch = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      watch.disconnect()
      // Through the reader's chunk, which brings pdf.js along: loaded only now.
      void import('./PdfViewer').then(async ({ drawFirstPage }) => {
        if (!alive) return
        const drawing = drawFirstPage(src, 160)
        close = drawing.close
        try {
          const found = await drawing.done
          keepThumb(src, size, found)
          if (alive) {
            setPicture(found.picture)
            told.current(found.pages)
          }
        } catch {
          // The tile keeps its sign; the reader says what is wrong.
        } finally {
          close = null
        }
      })
    })
    watch.observe(element)
    return () => {
      alive = false
      watch.disconnect()
      close?.()
    }
  }, [src, size])
  return (
    <div ref={holder} className="flex h-full w-full items-center justify-center">
      {picture ? <img src={picture} alt="" className="h-full w-auto rounded-sm bg-white shadow-soft" draggable={false} /> : <FileText size={34} className="text-muted" aria-hidden />}
    </div>
  )
}

function Tile({ item, source, editable, onOpen, onRemove }: { item: Attachment; source: AttachmentSource; editable: boolean; onOpen: () => void; onRemove: () => void }) {
  const { t, i18n } = useTranslation()
  const [pages, setPages] = useState<number | null>(null)
  if (item.kind === 'pdf')
    return (
      <div className="group relative" data-attachment={item.id} data-kind="pdf">
        <button type="button" onClick={onOpen} className="block w-full overflow-hidden rounded-xl border border-line bg-sheet-2 text-left hover:border-accent" aria-label={`${t('attachments.kind.pdf')}: ${item.name}`}>
          <div className="flex aspect-[4/3] items-center justify-center bg-sheet-2 p-3">
            <PdfThumb src={urlOf(source, item.id, 'file')} size={item.size} onPages={setPages} />
          </div>
          <div className="border-t border-line bg-sheet px-3 py-2">
            <div className="truncate text-sm font-semibold">{item.name}</div>
            <div className="text-xs text-muted">
              {t('attachments.kind.pdf')} · {pages !== null ? t('attachments.pages', { count: pages }) : formatBytes(item.size, i18n.language)}
            </div>
          </div>
        </button>
        {editable && (
          <span className="absolute top-1.5 right-1.5">
            <RemoveButton light onClick={onRemove} />
          </span>
        )}
      </div>
    )
  const working = busy(item)
  return (
    <div className="group relative" data-attachment={item.id} data-kind="video" data-status={item.status}>
      <button type="button" onClick={onOpen} className="relative block w-full overflow-hidden rounded-xl bg-ink/80 text-left" aria-label={`${t('attachments.kind.video')}: ${item.name}`}>
        <span className={`block aspect-[4/3] w-full ${working ? 'opacity-60 saturate-50' : ''}`}>
          {item.has_preview ? (
            <img src={urlOf(source, item.id, 'preview')} alt="" loading="lazy" className="h-full w-full object-cover" draggable={false} />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-white/60">
              <Film size={30} aria-hidden />
            </span>
          )}
        </span>
        {working ? (
          <span className="absolute inset-x-2 bottom-2 rounded-lg bg-black/55 px-2.5 py-2 text-xs font-semibold text-white backdrop-blur" data-converting>
            <span className="flex items-center gap-1.5">
              <Loader2 size={13} className="animate-spin" aria-hidden /> {item.status === 'queued' ? t('attachments.queued') : t('attachments.converting', { percent: item.progress ?? 0 })}
            </span>
            {item.status === 'converting' && (
              <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-white/25">
                <span className="block h-full rounded-full bg-white transition-all" style={{ width: `${item.progress ?? 0}%` }} />
              </span>
            )}
          </span>
        ) : (
          <>
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur">
                <Play size={20} fill="currentColor" className="ml-0.5" aria-hidden />
              </span>
            </span>
            {item.seconds !== null && <span className="absolute bottom-1.5 left-1.5 rounded bg-black/45 px-1.5 text-[0.7rem] font-bold text-white tabular-nums">{clock(item.seconds)}</span>}
            {item.codec === 'hevc' && <span className="absolute top-1.5 left-1.5 rounded bg-black/45 px-1.5 text-[0.65rem] font-bold tracking-wide text-white" data-hevc>HEVC</span>}
          </>
        )}
      </button>
      <div className="mt-1.5 truncate px-0.5 text-sm font-semibold">{item.name}</div>
      {editable && !working && (
        <span className="absolute top-1.5 right-1.5">
          <RemoveButton light onClick={onRemove} />
        </span>
      )}
    </div>
  )
}

/** A recording: its own buttons over a hidden `<audio>`, the drawn waveform filling up as it plays; the waveform is a
 * slider (arrows jump five seconds). */
function AudioRow({ item, source, editable, onRemove }: { item: Attachment; source: AttachmentSource; editable: boolean; onRemove: () => void }) {
  const { t } = useTranslation()
  const player = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [at, setAt] = useState(0)
  const [failed, setFailed] = useState(false)
  const [length, setLength] = useState<number | null>(null)
  const total = Math.max(1, item.seconds ?? length ?? 1)
  const wave = bars(item.id, 48)
  const toggle = () => {
    const element = player.current
    if (!element) return
    if (playing) {
      element.pause()
      return
    }
    try {
      const started = element.play()
      if (started && typeof started.catch === 'function') started.catch(() => setPlaying(false))
    } catch {
      setPlaying(false)
    }
  }
  const seek = (seconds: number) => {
    const element = player.current
    const to = Math.max(0, Math.min(total, seconds))
    if (element) element.currentTime = to
    setAt(to)
  }
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-sheet px-3 py-2.5" data-attachment={item.id} data-kind="audio">
      <audio
        ref={player}
        src={urlOf(source, item.id, 'file')}
        preload="none"
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setAt(0)
        }}
        onTimeUpdate={(event) => setAt(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => Number.isFinite(event.currentTarget.duration) && setLength(event.currentTarget.duration)}
        onError={() => setFailed(true)}
      />
      <button type="button" onClick={toggle} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink" aria-label={`${playing ? t('attachments.pause') : t('attachments.play')}: ${item.name}`}>
        {playing ? <Pause size={18} fill="currentColor" aria-hidden /> : <Play size={18} fill="currentColor" className="ml-0.5" aria-hidden />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{item.name}</div>
        {failed ? (
          <p className="mt-1 text-xs text-muted">{t('attachments.audioFailed')}</p>
        ) : (
          <div
            role="slider"
            tabIndex={0}
            aria-label={t('attachments.position')}
            aria-valuemin={0}
            aria-valuemax={Math.round(total)}
            aria-valuenow={Math.round(at)}
            aria-valuetext={`${clock(at)} / ${clock(total)}`}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault()
                seek(at + (event.key === 'ArrowRight' ? 5 : -5))
              }
            }}
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect()
              if (box.width > 0) seek(((event.clientX - box.left) / box.width) * total)
            }}
            className="mt-1 flex h-5 cursor-pointer items-center gap-[2px] rounded focus-visible:outline-2 focus-visible:outline-accent"
          >
            {wave.map((height, index) => (
              <span key={index} className={`w-full max-w-[4px] flex-1 rounded-full ${index / wave.length < at / total ? 'bg-accent' : 'bg-line'}`} style={{ height: `${height * 100}%` }} />
            ))}
          </div>
        )}
      </div>
      <span className="shrink-0 text-xs font-bold text-muted tabular-nums">
        {playing || at ? `${clock(at)} / ` : ''}
        {clock(total)}
      </span>
      {editable && <RemoveButton onClick={onRemove} />}
    </div>
  )
}

function LinkRow({ item, editable, onRemove }: { item: Attachment; editable: boolean; onRemove: () => void }) {
  const { t } = useTranslation()
  // Only an address that is one opens; anything else stands as text.
  const safe = item.url && /^https?:\/\//i.test(item.url) ? item.url : undefined
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-sheet px-3 py-2.5" data-attachment={item.id} data-kind="link">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Globe size={18} aria-hidden />
      </span>
      <a href={safe} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="min-w-0 flex-1 hover:text-accent" aria-label={`${item.name} (${t('attachments.newTab')})`}>
        <span className="block truncate text-sm font-semibold">{item.name}</span>
        <span className="block truncate text-xs text-muted">{hostOf(item.url)}</span>
      </a>
      <ExternalLink size={15} className="shrink-0 text-muted" aria-hidden />
      {editable && <RemoveButton onClick={onRemove} />}
    </div>
  )
}

/** The player of a video: the browser's own controls (they work best on every device), the still as poster, the file
 * to save. An HEVC video says where it plays and offers to convert it; one being converted says how far. */
function VideoViewer({ item, source, editable, onChanged, onClose, language }: { item: Attachment; source: AttachmentSource; editable: boolean; onChanged: (attachment: Attachment) => void; onClose: () => void; language: string }) {
  const { t } = useTranslation()
  const [asking, setAsking] = useState(false)
  const [problem, setProblem] = useState<{ code: string; values: Record<string, unknown> } | null>(null)
  const [unplayable, setUnplayable] = useState(false)
  const working = busy(item)
  const hevc = item.codec === 'hevc' && !working
  const convert = async () => {
    if (asking) return
    setAsking(true)
    setProblem(null)
    try {
      onChanged(await attachmentsApi.convert(item.id))
    } catch (error) {
      setProblem(error instanceof ApiError ? { code: error.code, values: error.values } : { code: 'internal_error', values: {} })
    } finally {
      setAsking(false)
    }
  }
  return (
    <Dialog title={item.name} onClose={onClose} above wide>
      <div className="overflow-hidden rounded-xl bg-black" data-video-view>
        <video
          key={`${item.id}-${item.codec}-${item.status}`}
          controls
          preload="metadata"
          playsInline
          poster={item.has_preview ? urlOf(source, item.id, 'preview') : undefined}
          src={urlOf(source, item.id, 'file')}
          className="aspect-video w-full bg-black"
          onError={() => setUnplayable(true)}
        />
      </div>
      {item.status === 'converting' && (
        <p className="mt-4 flex items-center gap-2 rounded-xl bg-sheet-2 px-4 py-3 text-sm text-ink-2" role="status">
          <Loader2 size={15} className="animate-spin text-accent" aria-hidden /> {t('attachments.viewer.converting', { percent: item.progress ?? 0 })}
        </p>
      )}
      {item.status === 'queued' && (
        <p className="mt-4 flex items-center gap-2 rounded-xl bg-sheet-2 px-4 py-3 text-sm text-ink-2" role="status">
          <Loader2 size={15} className="animate-spin text-accent" aria-hidden /> {t('attachments.viewer.queued')}
        </p>
      )}
      {item.status === 'failed' && (
        <p className="mt-4 rounded-xl bg-sheet-2 px-4 py-3 text-sm text-ink-2" data-convert-failed>
          {t('attachments.viewer.failed')}
        </p>
      )}
      {(hevc || (unplayable && !working)) && (
        <div className="mt-4 rounded-xl bg-sheet-2 px-4 py-3 text-sm text-ink-2" data-hevc-hint>
          <p>{hevc ? t('attachments.viewer.hevc') : t('attachments.viewer.unplayable')}</p>
          {editable && item.can_convert && (
            <button type="button" onClick={() => void convert()} disabled={asking} className="mt-3 inline-flex h-8 items-center justify-center gap-2 rounded-full bg-accent-soft px-3.5 text-sm font-semibold text-accent transition hover:brightness-[0.98] disabled:opacity-50">
              <Wand2 size={15} aria-hidden /> {t('attachments.viewer.convertNow')}
            </button>
          )}
        </div>
      )}
      {problem && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {errorText(problem.code, problem.values)}
        </p>
      )}
      <div className="mt-4 flex items-center justify-between gap-3 text-sm text-muted">
        <span>
          {item.seconds !== null ? `${clock(item.seconds)} · ` : ''}
          {formatBytes(item.size, language)}
          {item.codec === 'h264' && ' · H.264'}
        </span>
        <a href={urlOf(source, item.id, 'download')} download className="inline-flex h-8 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold text-ink-2 transition hover:bg-sheet-2">
          <Download size={15} aria-hidden /> {t('attachments.download')}
        </a>
      </div>
    </Dialog>
  )
}
