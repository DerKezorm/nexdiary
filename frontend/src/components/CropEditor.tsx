/**
 * Choosing the part of a photo that shows, without making a new picture (`lib/textPhoto.ts` has the numbers):
 *
 * - **the cover** (`CoverCropDialog`): the photo lies in the cover's frame and is moved (dragging, with a finger too)
 *   and zoomed (the slider, two fingers, the mouse wheel);
 * - **a photo of the text** (`TextCropDialog`): a free cut or one of a few shapes, and turning in quarter turns.
 *
 * Both work with the keyboard as well (arrows move, plus and minus zoom or resize, Tab reaches every part), and end
 * with "Fertig", "Abbrechen" or "Zurücksetzen". The photo is the smaller copy; the cut holds for the original.
 */
import { Loader2, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'

import {
  axesOf,
  COVER_MIDDLE,
  coverCropOf,
  coverStyle,
  cornerOf,
  cutFrom,
  cutLayout,
  fitRect,
  isCoverMiddle,
  moveAxis,
  moveRect,
  nextRotation,
  resizeRect,
  scaleRect,
  slopeOf,
  turned,
  turnRect,
  WHOLE,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAxis,
  type Corner,
  type CoverCrop,
  type Rect,
  type Rotation,
  type TextCut,
} from '../lib/textPhoto'
import { Dialog } from './Dialog'

/** One press of plus or minus, one notch of the wheel at most. */
const ZOOM_STEP = 1.1
/** One press of an arrow, as a part of the frame (with Shift four times as far). */
const MOVE_STEP = 0.04

type Size = [number, number]

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/** The size of the photo: as the page knows it, else as the picture says once it is loaded. */
function useNatural(width?: number, height?: number): [Size | null, (img: HTMLImageElement) => void] {
  const [loaded, setLoaded] = useState<Size | null>(null)
  const known: Size | null = width && height && width > 0 && height > 0 ? [width, height] : null
  return [known ?? loaded, (img) => img.naturalWidth > 0 && img.naturalHeight > 0 && setLoaded([img.naturalWidth, img.naturalHeight])]
}

/** The pointers on an element, for dragging with one and pinching with two. */
type Pointers = Map<number, { x: number; y: number }>

function pair(pointers: Pointers): [{ x: number; y: number }, { x: number; y: number }] | null {
  const [a, b] = [...pointers.values()]
  return a && b ? [a, b] : null
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function Buttons({ onReset, onCancel, onDone, disabled, resetLabel, doneLabel }: { onReset: () => void; onCancel: () => void; onDone: () => void; disabled: boolean; resetLabel: string; doneLabel: string }) {
  const { t } = useTranslation()
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
      <button type="button" onClick={onReset} className="inline-flex h-10 items-center rounded-full px-4 text-sm font-semibold text-ink-2 hover:bg-sheet-2">
        {resetLabel}
      </button>
      <span className="flex gap-2">
        <button type="button" onClick={onCancel} className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-semibold text-ink-2 hover:bg-sheet-2">
          {t('common.cancel')}
        </button>
        <button type="button" onClick={onDone} disabled={disabled} className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-semibold text-accent-ink hover:brightness-105 disabled:opacity-60">
          {doneLabel}
        </button>
      </span>
    </div>
  )
}

// ---- The cover ------------------------------------------------------------------------------------------------------

/** The cut being made, as fractions and a factor (whole numbers only when it is done). */
type View = { x: number; y: number; zoom: number }

function viewOf(crop: CoverCrop | null): View {
  const checked = coverCropOf(crop) ?? COVER_MIDDLE
  return { x: checked.x / 1000, y: checked.y / 1000, zoom: checked.zoom / 100 }
}

function cropOf(view: View): CoverCrop {
  return { x: clamp(Math.round(view.x * 1000), 0, 1000), y: clamp(Math.round(view.y * 1000), 0, 1000), zoom: clamp(Math.round(view.zoom * 100), ZOOM_MIN, ZOOM_MAX) }
}

/**
 * The part of a photo the cover shows. `ratio` is the cover's frame (width by height): the reading and writing pages
 * show it like this, the cards of the journal and the small pictures of lists keep to the same point of the photo.
 */
export function CoverCropDialog({
  src,
  value,
  width,
  height,
  ratio = 2,
  onDone,
  onClose,
}: {
  /** The smaller copy of the photo. */
  src: string
  value: CoverCrop | null
  width?: number
  height?: number
  ratio?: number
  /** The cut chosen; null for the middle (as without a cut). */
  onDone: (crop: CoverCrop | null) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [view, setView] = useState<View>(() => viewOf(value))
  const [natural, measure] = useNatural(width, height)
  const [failed, setFailed] = useState(false)
  const frame = useRef<HTMLDivElement>(null)
  const pointers = useRef<Pointers>(new Map())
  const shown = cropOf(view)

  /** The two directions of the frame as it stands on the screen; null before the photo's size is known. */
  const axes = () => {
    const box = frame.current?.getBoundingClientRect()
    if (!natural || !box || box.width <= 0 || box.height <= 0) return null
    return { box, axes: axesOf(box.width, box.height, natural[0], natural[1]) }
  }
  const pan = (dx: number, dy: number) => {
    const found = axes()
    if (!found) return
    const [across, down] = found.axes
    setView((current) => ({ ...current, x: moveAxis(across, current.x, current.zoom, dx), y: moveAxis(down, current.y, current.zoom, dy) }))
  }
  /** Zooms to `next` around a place of the frame (pixels from its corner; its middle when left out). */
  const zoomTo = (next: (zoom: number) => number, around?: { x: number; y: number }) => {
    const found = axes()
    setView((current) => {
      const zoom = clamp(next(current.zoom), ZOOM_MIN / 100, ZOOM_MAX / 100)
      if (!found) return { ...current, zoom }
      const [across, down] = found.axes
      const at = around ?? { x: found.box.width / 2, y: found.box.height / 2 }
      return { x: zoomAxis(across, current.x, current.zoom, zoom, at.x), y: zoomAxis(down, current.y, current.zoom, zoom, at.y), zoom }
    })
  }
  const zooming = useRef(zoomTo)
  useEffect(() => {
    zooming.current = zoomTo
  })

  // The wheel zooms here instead of scrolling the dialog: a listener that may hold the page still.
  useEffect(() => {
    const element = frame.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = element.getBoundingClientRect()
      const factor = clamp(Math.exp(-event.deltaY * 0.0015), 1 / ZOOM_STEP, ZOOM_STEP)
      zooming.current((zoom) => zoom * factor, { x: event.clientX - box.left, y: event.clientY - box.top })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [])

  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
  }
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const before = pointers.current.get(event.pointerId)
    if (!before) return
    const two = pair(pointers.current)
    const now = { x: event.clientX, y: event.clientY }
    pointers.current.set(event.pointerId, now)
    if (!two) {
      pan(now.x - before.x, now.y - before.y)
      return
    }
    // Two fingers: as far apart as they get, as large the photo; where their middle goes, the photo goes along.
    const after = pair(pointers.current)!
    const was = distance(two[0], two[1])
    const box = event.currentTarget.getBoundingClientRect()
    const middle = { x: (two[0].x + two[1].x) / 2, y: (two[0].y + two[1].y) / 2 }
    const middleNow = { x: (after[0].x + after[1].x) / 2, y: (after[0].y + after[1].y) / 2 }
    if (was > 0) zoomTo((zoom) => (zoom * distance(after[0], after[1])) / was, { x: middle.x - box.left, y: middle.y - box.top })
    pan(middleNow.x - middle.x, middleNow.y - middle.y)
  }
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId)
  }
  const key = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const box = frame.current?.getBoundingClientRect()
    const step = (event.shiftKey ? 4 : 1) * MOVE_STEP
    const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    if (event.key in moves) {
      event.preventDefault()
      const [x, y] = moves[event.key]
      pan(x * step * (box?.width ?? 0), y * step * (box?.height ?? 0))
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      zoomTo((zoom) => zoom * ZOOM_STEP)
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      zoomTo((zoom) => zoom / ZOOM_STEP)
    }
  }

  const style = coverStyle(shown)
  return (
    <Dialog title={t('cover.crop.title')} onClose={onClose} wide>
      <p id="cover-crop-hint" className="-mt-2 mb-4 text-sm text-ink-2">
        {t('cover.crop.hint')}
      </p>
      <div
        ref={frame}
        tabIndex={0}
        role="group"
        aria-label={t('cover.crop.area')}
        aria-describedby="cover-crop-hint"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
        style={{ aspectRatio: String(ratio) }}
        className="relative w-full cursor-grab touch-none overflow-hidden rounded-2xl bg-sheet-2 select-none focus-visible:ring-3 focus-visible:ring-accent focus-visible:outline-none active:cursor-grabbing"
        data-cover-crop-frame
      >
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(event) => measure(event.currentTarget)}
          onError={() => setFailed(true)}
          className="pointer-events-none block h-full w-full object-cover"
          style={style}
        />
        {/* Thirds, to place what matters. */}
        <span aria-hidden className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
          {Array.from({ length: 9 }, (_, index) => (
            <span key={index} className="border-[0.5px] border-white/35" />
          ))}
        </span>
        {failed && <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">{t('editor.crop.failed')}</p>}
      </div>
      <label className="mt-4 flex items-center gap-3 text-sm font-semibold text-ink-2">
        {t('cover.crop.zoom')}
        <input
          type="range"
          min={ZOOM_MIN}
          max={ZOOM_MAX}
          step={1}
          value={shown.zoom}
          onChange={(event) => {
            const next = Number(event.target.value) / 100
            zoomTo(() => next)
          }}
          className="min-w-0 flex-1 accent-[var(--accent)]"
          data-cover-crop-zoom
        />
        <span className="w-12 text-right text-muted tabular-nums">{shown.zoom} %</span>
      </label>
      <div className="mt-4">
        <p className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">{t('cover.crop.previews')}</p>
        <div className="flex items-end gap-3" aria-hidden>
          <span className="block aspect-[16/10] w-36 overflow-hidden rounded-xl bg-sheet-2">
            <img src={src} alt="" draggable={false} className="block h-full w-full object-cover" style={style} />
          </span>
          <span className="block h-14 w-20 overflow-hidden rounded-lg bg-sheet-2">
            <img src={src} alt="" draggable={false} className="block h-full w-full object-cover" style={style} />
          </span>
        </div>
      </div>
      <Buttons
        onReset={() => setView(viewOf(null))}
        onCancel={onClose}
        onDone={() => {
          const crop = cropOf(view)
          onDone(isCoverMiddle(crop) ? null : crop)
        }}
        disabled={false}
        resetLabel={t('cover.crop.reset')}
        doneLabel={t('cover.crop.done')}
      />
    </Dialog>
  )
}

// ---- A photo of the text --------------------------------------------------------------------------------------------

export type Shape = 'free' | 'original' | '4:3' | '3:2' | '16:9' | '1:1'
const SHAPES: Shape[] = ['free', 'original', '4:3', '3:2', '16:9', '1:1']
const RATIOS: Record<'4:3' | '3:2' | '16:9' | '1:1', number> = { '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9, '1:1': 1 }
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']
/** One press of an arrow, in thousandths of the photo (with Shift five times as far). */
const ARROW = 10

/** Width by height in pixels the shape asks for (null: any). Upright, the fixed shapes stand on their short side. */
function ratioOf(shape: Shape, upright: boolean, aspect: number): number | null {
  if (shape === 'free') return null
  if (shape === 'original') return aspect
  const ratio = RATIOS[shape]
  return upright ? 1 / ratio : ratio
}

/** The cut of a photo in the text: free or in a shape, turned in quarter turns. */
export function TextCropDialog({
  src,
  value,
  width,
  height,
  onDone,
  onClose,
}: {
  /** The smaller copy of the photo. */
  src: string
  value: TextCut
  width?: number
  height?: number
  onDone: (cut: TextCut) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [natural, measure] = useNatural(width, height)
  const [failed, setFailed] = useState(false)
  const [rot, setRot] = useState<Rotation>(value.rot)
  const [rect, setRect] = useState<Rect>(value.crop ?? WHOLE)
  const [shape, setShape] = useState<Shape>('free')
  const [upright, setUpright] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const pointers = useRef<Pointers>(new Map())
  const drag = useRef<{ mode: 'move' | Corner; start: Rect; from: { x: number; y: number } } | null>(null)
  const pinch = useRef<{ start: Rect; distance: number } | null>(null)

  const [wide, high] = natural ? turned(natural[0], natural[1], rot) : [1, 1]
  const aspect = wide / high
  const slope = slopeOf(ratioOf(shape, upright, aspect), aspect)
  const layout = natural ? cutLayout(natural[0], natural[1], { crop: null, rot }) : null

  /** Pixels on the stage as thousandths of the turned photo. */
  const scale = () => {
    const box = stage.current?.getBoundingClientRect()
    return box && box.width > 0 && box.height > 0 ? { x: 1000 / box.width, y: 1000 / box.height } : null
  }

  const choose = (next: Shape) => {
    setShape(next)
    // A fixed shape stands as the photo stands, until it is turned the other way.
    const standing = aspect < 1
    setUpright(standing)
    const ratio = ratioOf(next, standing, aspect)
    setRect((current) => fitRect(current, slopeOf(ratio, aspect)))
  }
  const flip = () => {
    const next = !upright
    setUpright(next)
    setRect((current) => fitRect(current, slopeOf(ratioOf(shape, next, aspect), aspect)))
  }
  const turn = () => {
    // The same part of the photo, turned along; a fixed shape turns with it.
    setRot((current) => nextRotation(current))
    setRect((current) => turnRect(current))
    setUpright((current) => !current)
  }

  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-handle]')
    event.currentTarget.setPointerCapture?.(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const two = pair(pointers.current)
    if (two) {
      drag.current = null
      pinch.current = { start: rect, distance: distance(two[0], two[1]) }
      return
    }
    const mode = target?.dataset.handle as 'move' | Corner | undefined
    drag.current = mode ? { mode, start: rect, from: { x: event.clientX, y: event.clientY } } : null
    if (mode) event.preventDefault()
  }
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const per = scale()
    if (!per) return
    const two = pair(pointers.current)
    if (two && pinch.current && pinch.current.distance > 0) {
      const { start, distance: was } = pinch.current
      setRect(scaleRect(start, distance(two[0], two[1]) / was, slope))
      return
    }
    const held = drag.current
    if (!held) return
    const dx = (event.clientX - held.from.x) * per.x
    const dy = (event.clientY - held.from.y) * per.y
    if (held.mode === 'move') setRect(moveRect(held.start, dx, dy))
    else {
      const corner = cornerOf(held.start, held.mode)
      setRect(resizeRect(held.start, held.mode, { x: corner.x + dx, y: corner.y + dy }, slope))
    }
  }
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) drag.current = null
  }

  const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  const keyOnCut = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = (event.shiftKey ? 5 : 1) * ARROW
    if (event.key in arrows) {
      event.preventDefault()
      const [x, y] = arrows[event.key]
      setRect((current) => moveRect(current, x * step, y * step))
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      setRect((current) => scaleRect(current, ZOOM_STEP, slope))
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      setRect((current) => scaleRect(current, 1 / ZOOM_STEP, slope))
    }
  }
  const keyOnCorner = (corner: Corner) => (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (!(event.key in arrows)) return
    event.preventDefault()
    event.stopPropagation()
    const step = (event.shiftKey ? 5 : 1) * ARROW
    const [x, y] = arrows[event.key]
    setRect((current) => {
      const at = cornerOf(current, corner)
      return resizeRect(current, corner, { x: at.x + x * step, y: at.y + y * step }, slope)
    })
  }

  const percent = (value: number) => `${Number((value / 10).toFixed(3))}%`
  const stageStyle: CSSProperties = { aspectRatio: String(Number(aspect.toFixed(5))), width: `min(100%, calc(55dvh * ${Number(aspect.toFixed(5))}))` }
  const chip = (on: boolean) => `rounded-full px-3 py-1 text-xs font-bold transition ${on ? 'bg-accent text-accent-ink' : 'bg-sheet-2 text-ink-2 hover:bg-accent-soft'}`

  return (
    <Dialog title={t('editor.crop.title')} onClose={onClose} wide>
      <p id="text-crop-hint" className="-mt-2 mb-4 text-sm text-ink-2">
        {t('editor.crop.hint')}
      </p>
      {!natural && (
        <div className="flex aspect-[3/2] w-full items-center justify-center rounded-2xl bg-sheet-2 text-sm text-muted">
          {failed ? (
            t('editor.crop.failed')
          ) : (
            <>
              <Loader2 size={18} className="mr-2 animate-spin" aria-hidden /> {t('editor.crop.loading')}
            </>
          )}
          {/* Loads the photo to learn its size. */}
          <img src={src} alt="" className="hidden" onLoad={(event) => measure(event.currentTarget)} onError={() => setFailed(true)} />
        </div>
      )}
      {natural && layout && (
        <div className="flex justify-center">
          <div
            ref={stage}
            role="group"
            aria-label={t('editor.crop.title')}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            style={stageStyle}
            className="relative touch-none overflow-hidden rounded-xl bg-sheet-2 select-none"
            data-text-crop-stage
          >
            <img src={src} alt="" draggable={false} className="pointer-events-none" style={layout.img} />
            <div
              tabIndex={0}
              role="group"
              aria-label={t('editor.crop.area')}
              aria-describedby="text-crop-hint"
              onKeyDown={keyOnCut}
              data-handle="move"
              className="absolute cursor-move border-2 border-white shadow-[0_0_0_100vmax_rgb(0_0_0/0.55)] focus-visible:outline-3 focus-visible:outline-accent"
              style={{ left: percent(rect.x), top: percent(rect.y), width: percent(rect.w), height: percent(rect.h) }}
              data-text-crop-rect
            >
              <span aria-hidden className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3">
                {Array.from({ length: 9 }, (_, index) => (
                  <span key={index} className="border-[0.5px] border-white/40" />
                ))}
              </span>
              {CORNERS.map((corner) => (
                <span
                  key={corner}
                  tabIndex={0}
                  role="button"
                  aria-label={t(`editor.crop.corner.${corner}`)}
                  onKeyDown={keyOnCorner(corner)}
                  data-handle={corner}
                  className={`absolute flex h-9 w-9 items-center justify-center focus-visible:outline-3 focus-visible:outline-accent ${corner.includes('n') ? '-top-[1.125rem]' : '-bottom-[1.125rem]'} ${corner.includes('w') ? '-left-[1.125rem]' : '-right-[1.125rem]'} ${corner === 'nw' || corner === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}`}
                >
                  <span aria-hidden className="pointer-events-none h-3.5 w-3.5 rounded-full border-2 border-white bg-accent shadow" />
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-1.5" role="group" aria-label={t('editor.crop.shape')}>
        {SHAPES.map((id) => (
          <button key={id} type="button" className={chip(shape === id)} aria-pressed={shape === id} onClick={() => choose(id)} disabled={!natural}>
            {id === 'free' ? t('editor.crop.free') : id === 'original' ? t('editor.crop.original') : id}
          </button>
        ))}
        {shape !== 'free' && shape !== 'original' && shape !== '1:1' && (
          <button type="button" className={chip(upright)} aria-pressed={upright} onClick={flip}>
            {t('editor.crop.upright')}
          </button>
        )}
        <span className="flex-1" />
        <button type="button" onClick={turn} disabled={!natural} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-sheet-2 px-3 text-xs font-bold text-ink-2 hover:bg-accent-soft hover:text-accent disabled:opacity-60">
          <RotateCw size={14} aria-hidden /> {t('editor.crop.rotate')}
        </button>
      </div>
      <Buttons
        onReset={() => {
          setRot(0)
          setRect(WHOLE)
          setShape('free')
          setUpright(false)
        }}
        onCancel={onClose}
        onDone={() => onDone(cutFrom(rect, rot))}
        disabled={!natural}
        resetLabel={t('editor.crop.reset')}
        doneLabel={t('editor.crop.done')}
      />
    </Dialog>
  )
}
