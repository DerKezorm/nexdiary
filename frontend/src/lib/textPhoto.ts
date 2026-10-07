/**
 * Cuts of a photo that never make a new picture: the file stays the original, and only a few numbers say how it is
 * shown.
 *
 * - **A photo in the text** carries them in its address, `photo:<id>#crop=x,y,w,h&rot=90`: first turned (90, 180 or 270
 *   degrees clockwise), then cut to the rectangle `x,y,w,h` in thousandths of the turned photo. The form is exact and
 *   canonical (a whole photo and no turn are left out, the cut comes before the turn, numbers without leading zeros);
 *   anything else in the fragment is no cut at all and the photo shows whole, as the server drops it when it saves.
 * - **The cover** keeps `{x, y, zoom}` beside the day: `x`, `y` in thousandths of the photo, `zoom` in percent (100: the
 *   photo just fills the frame). The point `x, y` is where the frame holds on to the photo: it stands at the same
 *   place of every frame, whatever its shape (`object-position`), and the zoom grows around it. So the wide cover of
 *   the reading page, the cards of the journal and the small pictures of a list show the same part of the photo.
 *
 * Only numbers checked here ever reach a style; nothing written in a text becomes CSS or markup.
 */
import type { CSSProperties } from 'react'

export type Rotation = 0 | 90 | 180 | 270
/** A rectangle in thousandths of the turned photo. */
export type Rect = { x: number; y: number; w: number; h: number }
export type TextCut = { crop: Rect | null; rot: Rotation }
export const NO_CUT: TextCut = { crop: null, rot: 0 }

export type CoverCrop = { x: number; y: number; zoom: number }
/** What a cover without its own cut shows: the middle, the photo just filling the frame. */
export const COVER_MIDDLE: CoverCrop = { x: 500, y: 500, zoom: 100 }

export const FULL = 1000
/** The smallest side of a cut, in thousandths. */
export const MIN_SIDE = 10
export const ZOOM_MIN = 100
export const ZOOM_MAX = 400
/** Longer than any canonical fragment (`crop=1000,1000,1000,1000&rot=270` has 32 characters). */
export const FRAGMENT_MAX = 64

const NUMBER = /^(?:0|[1-9]\d{0,3})$/
const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270]

function number(text: string): number | null {
  if (!NUMBER.test(text)) return null
  const value = Number(text)
  return value <= FULL ? value : null
}

function isFull(rect: Rect): boolean {
  return rect.x === 0 && rect.y === 0 && rect.w === FULL && rect.h === FULL
}

/** Whether a rectangle is one a cut may be: whole thousandths, inside the photo, no side below the smallest. */
export function validRect(rect: Rect): boolean {
  const values = [rect.x, rect.y, rect.w, rect.h]
  if (!values.every((value) => Number.isInteger(value) && value >= 0 && value <= FULL)) return false
  return rect.w >= MIN_SIDE && rect.h >= MIN_SIDE && rect.x + rect.w <= FULL && rect.y + rect.h <= FULL
}

/**
 * The cut a fragment (without its `#`) stands for; `null` when it is not exactly the canonical form. An empty fragment
 * is no cut.
 */
export function parseFragment(fragment: string): TextCut | null {
  if (fragment === '') return NO_CUT
  if (fragment.length > FRAGMENT_MAX) return null
  const parts = fragment.split('&')
  if (parts.length > 2) return null
  let crop: Rect | null = null
  let rot: Rotation = 0
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (index === 0 && part.startsWith('crop=')) {
      const values = part.slice('crop='.length).split(',')
      if (values.length !== 4) return null
      const numbers = values.map(number)
      if (numbers.some((value) => value === null)) return null
      const [x, y, w, h] = numbers as number[]
      const rect = { x, y, w, h }
      // A whole photo is written as no cut at all.
      if (!validRect(rect) || isFull(rect)) return null
      crop = rect
    } else if (index === parts.length - 1 && part.startsWith('rot=')) {
      const turn = part.slice('rot='.length)
      if (turn !== '90' && turn !== '180' && turn !== '270') return null
      rot = Number(turn) as Rotation
    } else return null
  }
  return { crop, rot }
}

/** The fragment for a cut, `#` included, in the canonical form; nothing for no cut. */
export function formatFragment(cut: TextCut | null | undefined): string {
  if (!cut) return ''
  const parts: string[] = []
  if (cut.crop && validRect(cut.crop) && !isFull(cut.crop)) parts.push(`crop=${cut.crop.x},${cut.crop.y},${cut.crop.w},${cut.crop.h}`)
  if (cut.rot && ROTATIONS.includes(cut.rot)) parts.push(`rot=${cut.rot}`)
  return parts.length ? `#${parts.join('&')}` : ''
}

/** Whether a cut changes anything. */
export function isCut(cut: TextCut | null | undefined): boolean {
  return formatFragment(cut) !== ''
}

/** The cut of a photo's address after its id: `#…` or nothing. Anything but the canonical form is no cut. */
export function cutOfAddress(rest: string | undefined): TextCut {
  if (!rest) return NO_CUT
  if (!rest.startsWith('#')) return NO_CUT
  return parseFragment(rest.slice(1)) ?? NO_CUT
}

/** The cover's cut as it came from the server, checked again: exactly the three whole numbers in their ranges. */
export function coverCropOf(raw: unknown): CoverCrop | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const keys = Object.keys(raw)
  if (keys.length !== 3) return null
  const { x, y, zoom } = raw as Record<string, unknown>
  const whole = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high
  if (!whole(x, 0, FULL) || !whole(y, 0, FULL) || !whole(zoom, ZOOM_MIN, ZOOM_MAX)) return null
  return { x, y, zoom }
}

/** Whether a cover's cut shows anything else than the middle. */
export function isCoverMiddle(crop: CoverCrop | null): boolean {
  return !crop || (crop.x === COVER_MIDDLE.x && crop.y === COVER_MIDDLE.y && crop.zoom === COVER_MIDDLE.zoom)
}

function round(value: number, places = 4): string {
  return String(Number(value.toFixed(places)))
}

/** The style of a cover's picture (it fills its frame, `object-fit: cover`); the frame hides what the zoom pushes out. */
export function coverStyle(raw: CoverCrop | null | undefined): CSSProperties {
  const crop = coverCropOf(raw)
  if (!crop) return {}
  const point = `${round(crop.x / 10)}% ${round(crop.y / 10)}%`
  return crop.zoom === ZOOM_MIN ? { objectPosition: point } : { objectPosition: point, transform: `scale(${round(crop.zoom / 100)})`, transformOrigin: point }
}

// ---- Moving and zooming a cover -------------------------------------------------------------------------------------

/** One direction of the frame: its length, and the photo's length at zoom 100 (just filling it). */
export type Axis = { frame: number; base: number }

/** Both directions for a frame and a photo of these sizes (in the same unit, pixels say). */
export function axesOf(frameWidth: number, frameHeight: number, photoWidth: number, photoHeight: number): [Axis, Axis] {
  const fill = Math.max(frameWidth / photoWidth, frameHeight / photoHeight)
  return [
    { frame: frameWidth, base: photoWidth * fill },
    { frame: frameHeight, base: photoHeight * fill },
  ]
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/** Where the photo begins, seen from the frame's start, when the point `at` (0..1) is held at the same place of the
 * frame and the photo is `zoom` times as large as filling it. */
export function startOf(axis: Axis, at: number, zoom: number): number {
  return axis.frame * at - axis.base * zoom * at
}

/** Less than this much longer than the frame, the photo cannot move in that direction. */
const STILL = 0.5

/** The point to hold after moving the photo by `delta` (pixels): it follows the finger and never leaves a gap. */
export function moveAxis(axis: Axis, at: number, zoom: number, delta: number): number {
  const length = axis.base * zoom
  if (length - axis.frame < STILL) return at
  return clamp((startOf(axis, at, zoom) + delta) / (axis.frame - length), 0, 1)
}

/** The point to hold after zooming from `zoom` to `next` around the place `around` of the frame (pixels): what stood
 * there stays there. */
export function zoomAxis(axis: Axis, at: number, zoom: number, next: number, around: number): number {
  const length = axis.base * zoom
  const after = axis.base * next
  if (after - axis.frame < STILL) return at
  const part = (around - startOf(axis, at, zoom)) / length
  return clamp((around - part * after) / (axis.frame - after), 0, 1)
}

// ---- Showing a photo of the text -----------------------------------------------------------------------------------

/** The width and height of a photo once it is turned. */
export function turned(width: number, height: number, rot: Rotation): [number, number] {
  return rot === 90 || rot === 270 ? [height, width] : [width, height]
}

export type CutLayout = {
  /** Width by height of what shows: the cut of the turned photo. */
  ratio: number
  /** The original picture, placed and turned inside a frame of that ratio which hides the rest. */
  img: CSSProperties
}

/**
 * How to show a cut photo without a new picture: a frame of the cut's shape that hides what lies outside, and in it
 * the whole original, as large as the cut asks, its middle where the cut puts it, turned around that middle. All in
 * percent of the frame, so it fits any width. `null` while the photo's size is not known.
 */
export function cutLayout(width: number, height: number, cut: TextCut): CutLayout | null {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) return null
  const rot = ROTATIONS.includes(cut.rot) ? cut.rot : 0
  const crop = cut.crop && validRect(cut.crop) ? cut.crop : { x: 0, y: 0, w: FULL, h: FULL }
  const [wide, high] = turned(width, height, rot)
  const ratio = (wide * crop.w) / (high * crop.h)
  // The turned photo in percent of the frame: its size and where its middle lies.
  const across = (FULL * 100) / crop.w
  const down = (FULL * 100) / crop.h
  const left = ((FULL / 2 - crop.x) / crop.w) * 100
  const top = ((FULL / 2 - crop.y) / crop.h) * 100
  // Turned a quarter, the picture's own width is the turned height (and the other way round).
  const quarter = rot === 90 || rot === 270
  const imgWidth = quarter ? down / ratio : across
  const imgHeight = quarter ? across * ratio : down
  return {
    ratio,
    img: {
      position: 'absolute',
      left: `${round(left)}%`,
      top: `${round(top)}%`,
      width: `${round(imgWidth)}%`,
      height: `${round(imgHeight)}%`,
      maxWidth: 'none',
      maxHeight: 'none',
      transform: rot ? `translate(-50%, -50%) rotate(${rot}deg)` : 'translate(-50%, -50%)',
    },
  }
}

/** The ratio as a CSS number, for the custom property the frame reads (`--cut-ratio`). */
export function ratioValue(ratio: number): string {
  return round(clamp(ratio, 0.01, 100), 5)
}

// ---- Cutting a photo of the text ------------------------------------------------------------------------------------

export type Point = { x: number; y: number }
/** The four corners of a cut, by compass: north-west is top left. */
export type Corner = 'nw' | 'ne' | 'sw' | 'se'
/** The smallest side the editor lets a cut shrink to, in thousandths (larger than the least the form allows, so
 * that a finger can still take hold of it). */
export const EDIT_MIN = 60

export const WHOLE: Rect = { x: 0, y: 0, w: FULL, h: FULL }

/**
 * A shape asked for, as the cut's height per width in thousandths of the turned photo (`null`: any shape). `ratio` is
 * width by height in pixels, `aspect` the turned photo's width by height.
 */
export function slopeOf(ratio: number | null, aspect: number): number | null {
  return ratio && aspect > 0 ? aspect / ratio : null
}

export function cornerOf(rect: Rect, corner: Corner): Point {
  return { x: corner === 'nw' || corner === 'sw' ? rect.x : rect.x + rect.w, y: corner === 'nw' || corner === 'ne' ? rect.y : rect.y + rect.h }
}

const OPPOSITE: Record<Corner, Corner> = { nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' }

/** The cut moved by `dx`, `dy` thousandths, never past the photo's edges. */
export function moveRect(rect: Rect, dx: number, dy: number): Rect {
  return { ...rect, x: clamp(rect.x + dx, 0, FULL - rect.w), y: clamp(rect.y + dy, 0, FULL - rect.h) }
}

/** The cut with one corner taken to `point`, the opposite one holding still; in the shape asked for, inside the photo,
 * no side below the smallest. */
export function resizeRect(rect: Rect, corner: Corner, point: Point, slope: number | null, least = EDIT_MIN): Rect {
  const anchor = cornerOf(rect, OPPOSITE[corner])
  const right = corner === 'ne' || corner === 'se'
  const down = corner === 'sw' || corner === 'se'
  const roomX = right ? FULL - anchor.x : anchor.x
  const roomY = down ? FULL - anchor.y : anchor.y
  let w = clamp(right ? point.x - anchor.x : anchor.x - point.x, 0, roomX)
  let h = clamp(down ? point.y - anchor.y : anchor.y - point.y, 0, roomY)
  if (slope) {
    // The side that changed more leads, the other follows in the shape; then as much of it as fits.
    if (Math.abs(w - rect.w) >= Math.abs(h - rect.h) / slope) h = w * slope
    else w = h / slope
    const fit = Math.min(1, roomX / Math.max(w, 1e-9), roomY / Math.max(h, 1e-9))
    w *= fit
    h *= fit
    const grow = Math.max(1, least / Math.max(w, 1e-9), least / Math.max(h, 1e-9))
    w = Math.min(w * grow, roomX)
    h = Math.min(h * grow, roomY)
  } else {
    w = Math.min(Math.max(w, least), roomX)
    h = Math.min(Math.max(h, least), roomY)
  }
  return { x: right ? anchor.x : anchor.x - w, y: down ? anchor.y : anchor.y - h, w, h }
}

/** The cut made `factor` times as large around its middle, in its shape, inside the photo. */
export function scaleRect(rect: Rect, factor: number, slope: number | null, least = EDIT_MIN): Rect {
  let w = rect.w * factor
  let h = slope ? w * slope : rect.h * factor
  const fit = Math.min(1, FULL / w, FULL / h)
  w *= fit
  h *= fit
  const grow = Math.max(1, least / w, least / h)
  w = Math.min(w * grow, FULL)
  h = Math.min(h * grow, FULL)
  const middle = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
  return { x: clamp(middle.x - w / 2, 0, FULL - w), y: clamp(middle.y - h / 2, 0, FULL - h), w, h }
}

/** The largest cut of a shape around the middle of the present one. */
export function fitRect(rect: Rect, slope: number | null): Rect {
  if (!slope) return rect
  let w: number = FULL
  let h = w * slope
  if (h > FULL) {
    h = FULL
    w = h / slope
  }
  const middle = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
  return { x: clamp(middle.x - w / 2, 0, FULL - w), y: clamp(middle.y - h / 2, 0, FULL - h), w, h }
}

/** The same part of the photo once it is turned a quarter further, clockwise. */
export function turnRect(rect: Rect): Rect {
  return { x: FULL - rect.y - rect.h, y: rect.x, w: rect.h, h: rect.w }
}

export function nextRotation(rot: Rotation): Rotation {
  return ((rot + 90) % 360) as Rotation
}

/** The cut in whole thousandths, as it is written; the whole photo is no cut. */
export function cutFrom(rect: Rect, rot: Rotation): TextCut {
  const x = clamp(Math.round(rect.x), 0, FULL - MIN_SIDE)
  const y = clamp(Math.round(rect.y), 0, FULL - MIN_SIDE)
  const w = clamp(Math.round(rect.w), MIN_SIDE, FULL - x)
  const h = clamp(Math.round(rect.h), MIN_SIDE, FULL - y)
  const crop = { x, y, w, h }
  return { crop: isFull(crop) ? null : crop, rot }
}
