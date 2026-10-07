/**
 * The big view of a photo: the whole picture on a darkened page, from every place a photo stands (text, reading page,
 * shared day, notes, "Today", cover). Escape, the cross and a tap beside the picture close it; arrows and a swipe move
 * between the photos of the same list. It loads the original through the route it is given (the own one, or the one
 * of a share, both check the rights), keeps the focus inside while it is open (the page behind is `inert`), tells
 * screen readers it is a modal dialog, and gives the focus back to what opened it.
 */
import { ChevronLeft, ChevronRight, Trash2, X } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { useDeletePhotos } from './PhotoDelete'

export type ViewerPhoto = {
  id: string
  /** The original, from the route that checks the rights. */
  src: string
  caption?: string
  alt?: string
  /** Asks, deletes, and says whether the photo is gone (true): then it leaves the view. */
  onDelete?: () => boolean | void | Promise<boolean | void>
}

type Open = (photos: ViewerPhoto[], index: number, opener?: HTMLElement | null) => void
const NOTHING: { open: Open } = { open: () => undefined }
const Context = createContext(NOTHING)

// eslint-disable-next-line react-refresh/only-export-components
export function useLightbox(): { open: Open } {
  return useContext(Context)
}

export function LightboxProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<{ photos: ViewerPhoto[]; index: number } | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const open = useCallback<Open>((photos, index, element) => {
    if (photos.length === 0) return
    opener.current = element ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setView({ photos, index: Math.max(0, Math.min(index, photos.length - 1)) })
  }, [])
  const close = useCallback(() => {
    setView(null)
    const back = opener.current
    opener.current = null
    // After the page behind is no longer inert.
    window.setTimeout(() => back?.focus?.(), 0)
  }, [])
  const value = useMemo(() => ({ open }), [open])
  return (
    <Context.Provider value={value}>
      {children}
      {view && createPortal(<Viewer start={view} onClose={close} />, document.body)}
    </Context.Provider>
  )
}

const SWIPE = 56

function Viewer({ start, onClose }: { start: { photos: ViewerPhoto[]; index: number }; onClose: () => void }) {
  const { t } = useTranslation()
  const deleting = useDeletePhotos()
  const [photos, setPhotos] = useState(start.photos)
  const [index, setIndex] = useState(start.index)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const root = useRef<HTMLDivElement>(null)
  const down = useRef<{ x: number; y: number; id: number } | null>(null)
  const photo = photos[index]

  const go = useCallback(
    (step: number) => {
      setIndex((current) => {
        const next = current + step
        return next < 0 || next >= photos.length ? current : next
      })
    },
    [photos.length],
  )

  // The page behind stands still and is out of reach for the keyboard and for screen readers.
  useEffect(() => {
    const page = document.getElementById('root')
    page?.setAttribute('inert', '')
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    root.current?.querySelector<HTMLElement>('[data-close]')?.focus()
    return () => {
      page?.removeAttribute('inert')
      document.body.style.overflow = overflow
    }
  }, [])

  useEffect(() => {
    setState('loading')
  }, [photo?.id])

  // The neighbours are fetched ahead, so that an arrow shows the next photo at once.
  useEffect(() => {
    for (const near of [photos[index - 1], photos[index + 1]]) if (near) new Image().src = near.src
  }, [photos, index])

  useEffect(() => {
    if (photos.length === 0) onClose()
  }, [photos.length, onClose])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // A question above the view (delete) has the keys while it is open.
      if (deleting.active) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      } else if (event.key === 'ArrowLeft') go(-1)
      else if (event.key === 'ArrowRight') go(1)
      else if (event.key === 'Tab') {
        const items = [...(root.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])]
        if (items.length === 0) return
        const first = items[0]
        const last = items[items.length - 1]
        const active = document.activeElement
        if (!root.current?.contains(active)) {
          event.preventDefault()
          first.focus()
        } else if (event.shiftKey && active === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [deleting.active, go, onClose])

  if (!photo) return null

  const remove = async () => {
    if (!photo.onDelete) return
    const gone = await photo.onDelete()
    if (gone !== true) return
    setPhotos((current) => current.filter((item) => item.id !== photo.id))
    setIndex((current) => Math.max(0, Math.min(current, photos.length - 2)))
  }

  const pointerDown = (event: ReactPointerEvent) => {
    down.current = { x: event.clientX, y: event.clientY, id: event.pointerId }
  }
  const pointerUp = (event: ReactPointerEvent) => {
    const from = down.current
    down.current = null
    if (!from || from.id !== event.pointerId) return
    const dx = event.clientX - from.x
    const dy = event.clientY - from.y
    if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1)
  }
  // A tap beside the picture (on the dark) closes; on the picture, the bar or a button it does not.
  const stageClick = (event: React.MouseEvent) => {
    if (event.target === event.currentTarget) onClose()
  }
  const onKeyDown = (event: ReactKeyboardEvent) => {
    event.stopPropagation()
  }

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={t('photoView.title')}
      className="fixed inset-0 z-[60] flex flex-col bg-black/95 text-white"
      data-lightbox
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
        <p className="min-w-0 flex-1 text-sm font-semibold tabular-nums text-white/80" aria-live="polite">
          {photos.length > 1 ? t('photoView.counter', { n: index + 1, total: photos.length }) : ''}
        </p>
        {photo.onDelete && (
          <button type="button" onClick={() => void remove()} className="rounded-full p-2.5 text-white/85 hover:bg-white/15" aria-label={t('photoView.delete')}>
            <Trash2 size={20} aria-hidden />
          </button>
        )}
        <button type="button" data-close onClick={onClose} className="rounded-full p-2.5 text-white/85 hover:bg-white/15" aria-label={t('common.close')}>
          <X size={22} aria-hidden />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-3 sm:px-16" onClick={stageClick} onPointerDown={pointerDown} onPointerUp={pointerUp} style={{ touchAction: 'pan-y' }}>
        {index > 0 && (
          <button type="button" onClick={() => go(-1)} className="absolute top-1/2 left-1 z-10 -translate-y-1/2 rounded-full bg-black/45 p-2 hover:bg-white/20 sm:left-2 sm:p-3" aria-label={t('photoView.previous')}>
            <ChevronLeft size={26} aria-hidden />
          </button>
        )}
        <img
          key={photo.id}
          src={photo.src}
          alt={photo.alt ?? photo.caption ?? t('photos.alt')}
          draggable={false}
          onLoad={() => setState('ready')}
          onError={() => setState('failed')}
          className={`max-h-full max-w-full object-contain transition-opacity ${state === 'ready' ? 'opacity-100' : 'opacity-0'}`}
          data-photo-view={photo.id}
        />
        {state === 'failed' && <p className="absolute text-sm text-white/80">{t('photoView.failed')}</p>}
        {index < photos.length - 1 && (
          <button type="button" onClick={() => go(1)} className="absolute top-1/2 right-1 z-10 -translate-y-1/2 rounded-full bg-black/45 p-2 hover:bg-white/20 sm:right-2 sm:p-3" aria-label={t('photoView.next')}>
            <ChevronRight size={26} aria-hidden />
          </button>
        )}
      </div>
      <div className="min-h-[3.25rem] px-5 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] text-center">
        {photo.caption && <p className="mx-auto max-w-2xl font-serif text-base leading-snug break-words text-white/90">{photo.caption}</p>}
      </div>
    </div>
  )
}
