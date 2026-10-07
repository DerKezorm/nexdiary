/**
 * Choosing the part of a photo that shows: the cover moved with a finger, two fingers, the wheel, the slider and the
 * keyboard, a photo of the text cut freely or in a shape and turned; "Fertig" hands over whole numbers, "Abbrechen"
 * nothing, "Zurücksetzen" the whole photo again.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../i18n'
import { changeLanguage } from '../i18n'
import type { CoverCrop, TextCut } from '../lib/textPhoto'
import { CoverCropDialog, TextCropDialog } from './CropEditor'

let root: Root
let box: HTMLDivElement

function show(element: React.ReactNode): HTMLDivElement {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  act(() => root.render(element))
  return box
}

beforeAll(() => changeLanguage('de', false))

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.restoreAllMocks()
})

/** Where an element stands on the screen, as a browser would say. */
function place(element: Element, width: number, height: number, left = 0, top = 0): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect)
}

function pointer(element: Element, type: string, id: number, x: number, y: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
  Object.defineProperty(event, 'pointerId', { value: id })
  act(() => {
    element.dispatchEvent(event)
  })
}

function key(element: Element, name: string, shiftKey = false): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }))
  })
}

function button(name: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)!
}

function loadInto(img: HTMLImageElement, width: number, height: number): void {
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true })
  act(() => {
    img.dispatchEvent(new Event('load'))
  })
}

describe('the cut of the cover', () => {
  // A photo of 400 by 400 in a frame of 400 by 200: filling it, half of its height shows.
  function open(value: CoverCrop | null = null) {
    const done = vi.fn()
    const closed = vi.fn()
    const out = show(<CoverCropDialog src="/api/photos/p/preview" value={value} width={400} height={400} onDone={done} onClose={closed} />)
    const frame = out.querySelector<HTMLElement>('[data-cover-crop-frame]')!
    place(frame, 400, 200)
    return { out, frame, done, closed, img: frame.querySelector('img')! }
  }

  it('shows the photo in the cover’s frame, from the smaller copy, as the cut says', () => {
    const { frame, img } = open({ x: 250, y: 700, zoom: 150 })
    expect(frame.style.aspectRatio).toBe('2 / 1')
    expect(img.getAttribute('src')).toBe('/api/photos/p/preview')
    expect([img.style.objectPosition, img.style.transform, img.style.transformOrigin]).toEqual(['25% 70%', 'scale(1.5)', '25% 70%'])
    expect(document.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('Ausschnitt des Titelbilds')
  })

  it('moves the photo with a finger, never beyond its edge', () => {
    const { frame, done } = open()
    pointer(frame, 'pointerdown', 1, 200, 100)
    pointer(frame, 'pointermove', 1, 200, 150)
    pointer(frame, 'pointerup', 1, 200, 150)
    // Down by 50 of the 200 that are hidden: the frame holds on a quarter down; across nothing can move.
    act(() => button('Fertig').click())
    expect(done).toHaveBeenLastCalledWith({ x: 500, y: 250, zoom: 100 })
    pointer(frame, 'pointerdown', 2, 200, 100)
    pointer(frame, 'pointermove', 2, 50, -400)
    pointer(frame, 'pointerup', 2, 50, -400)
    act(() => button('Fertig').click())
    expect(done).toHaveBeenLastCalledWith({ x: 500, y: 1000, zoom: 100 })
  })

  it('zooms with two fingers around their middle', () => {
    const { frame, done } = open()
    pointer(frame, 'pointerdown', 1, 150, 100)
    pointer(frame, 'pointerdown', 2, 250, 100)
    pointer(frame, 'pointermove', 2, 350, 100)
    pointer(frame, 'pointerup', 1, 150, 100)
    pointer(frame, 'pointerup', 2, 350, 100)
    act(() => button('Fertig').click())
    const crop = done.mock.lastCall![0] as CoverCrop
    // Twice as far apart: twice the zoom; the middle moved right by 50, so did the photo.
    expect(crop.zoom).toBe(200)
    expect(crop.x).toBeLessThan(500)
    expect(crop.y).toBe(500)
  })

  it('zooms with the wheel, the slider and plus and minus, and moves with the arrows', () => {
    const { frame, done, img } = open()
    act(() => {
      frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 200, clientY: 100, bubbles: true, cancelable: true }))
    })
    expect(img.style.transform).toBe('scale(1.1)')
    const slider = document.querySelector<HTMLInputElement>('[data-cover-crop-zoom]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(slider, '300')
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(slider.value).toBe('300')
    key(frame, '-')
    key(frame, '+')
    key(frame, '+')
    key(frame, 'ArrowRight')
    key(frame, 'ArrowDown', true)
    act(() => button('Fertig').click())
    const crop = done.mock.lastCall![0] as CoverCrop
    expect(crop.zoom).toBe(330)
    // To the right and down: the photo follows, the point held moves up and to the left.
    expect(crop.x).toBeLessThan(500)
    expect(crop.y).toBeLessThan(500)
    expect(Number.isInteger(crop.x) && Number.isInteger(crop.y)).toBe(true)
  })

  it('stops at its limits', () => {
    const { frame, done } = open()
    for (let index = 0; index < 30; index++) key(frame, '+')
    act(() => button('Fertig').click())
    expect(done.mock.lastCall![0].zoom).toBe(400)
    for (let index = 0; index < 30; index++) key(frame, '-')
    act(() => button('Fertig').click())
    // Back at just filling the frame and in the middle: no cut at all.
    expect(done).toHaveBeenLastCalledWith(null)
  })

  it('takes the cut back on "Zurücksetzen" and hands nothing over on "Abbrechen"', () => {
    const { done, closed, img } = open({ x: 100, y: 100, zoom: 300 })
    act(() => button('Zurücksetzen').click())
    expect(img.style.transform).toBe('')
    expect(img.style.objectPosition).toBe('50% 50%')
    act(() => button('Abbrechen').click())
    expect(closed).toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
    act(() => button('Fertig').click())
    expect(done).toHaveBeenLastCalledWith(null)
  })

  it('learns the photo’s size from the picture when the page does not know it', () => {
    const done = vi.fn()
    const out = show(<CoverCropDialog src="/x" value={null} onDone={done} onClose={() => undefined} />)
    const frame = out.querySelector<HTMLElement>('[data-cover-crop-frame]')!
    place(frame, 400, 200)
    // Before that a finger moves nothing.
    pointer(frame, 'pointerdown', 1, 200, 100)
    pointer(frame, 'pointermove', 1, 200, 150)
    pointer(frame, 'pointerup', 1, 200, 150)
    act(() => button('Fertig').click())
    expect(done).toHaveBeenLastCalledWith(null)
    loadInto(frame.querySelector('img')!, 800, 800)
    pointer(frame, 'pointerdown', 1, 200, 100)
    pointer(frame, 'pointermove', 1, 200, 150)
    pointer(frame, 'pointerup', 1, 200, 150)
    act(() => button('Fertig').click())
    expect(done).toHaveBeenLastCalledWith({ x: 500, y: 250, zoom: 100 })
  })

  it('reaches every part with Tab: the photo, the slider, the buttons', () => {
    const { frame } = open()
    expect(frame.tabIndex).toBe(0)
    expect(frame.getAttribute('aria-label')).toBe('Foto im Ausschnitt verschieben')
    expect(document.getElementById(frame.getAttribute('aria-describedby')!)?.textContent).toContain('Pfeiltasten')
    for (const name of ['Zurücksetzen', 'Abbrechen', 'Fertig']) expect(button(name)).toBeTruthy()
  })
})

describe('the cut of a photo in the text', () => {
  /** A photo of 400 by 300, on a stage of 400 by 300 pixels. */
  function open(value: TextCut = { crop: null, rot: 0 }) {
    const done = vi.fn()
    const closed = vi.fn()
    const out = show(<TextCropDialog src="/api/photos/p/preview" value={value} width={400} height={300} onDone={done} onClose={closed} />)
    const stage = out.querySelector<HTMLElement>('[data-text-crop-stage]')!
    place(stage, 400, 300)
    const cut = () => out.querySelector<HTMLElement>('[data-text-crop-rect]')!
    const corner = (name: string) => out.querySelector<HTMLElement>(`[data-handle="${name}"]`)!
    return { out, stage, cut, corner, done, closed }
  }
  const finish = (done: ReturnType<typeof vi.fn>) => {
    act(() => button('Fertig').click())
    return done.mock.lastCall![0] as TextCut
  }

  it('moves the cut with a finger and takes a corner along', () => {
    const { stage, corner, cut, done } = open({ crop: { x: 100, y: 100, w: 500, h: 500 }, rot: 0 })
    expect([cut().style.left, cut().style.top, cut().style.width, cut().style.height]).toEqual(['10%', '10%', '50%', '50%'])
    // 40 pixels of 400 are 100 thousandths.
    pointer(cut(), 'pointerdown', 1, 200, 150)
    pointer(stage, 'pointermove', 1, 240, 120)
    pointer(stage, 'pointerup', 1, 240, 120)
    expect(finish(done)).toEqual({ crop: { x: 200, y: 0, w: 500, h: 500 }, rot: 0 })
    pointer(corner('se'), 'pointerdown', 2, 280, 150)
    pointer(stage, 'pointermove', 2, 320, 180)
    pointer(stage, 'pointerup', 2, 320, 180)
    expect(finish(done)).toEqual({ crop: { x: 200, y: 0, w: 600, h: 600 }, rot: 0 })
  })

  it('grows with two fingers, in its shape', () => {
    const { stage, cut, done } = open({ crop: { x: 300, y: 300, w: 200, h: 200 }, rot: 0 })
    pointer(cut(), 'pointerdown', 1, 150, 120)
    pointer(stage, 'pointerdown', 2, 190, 120)
    pointer(stage, 'pointermove', 2, 230, 120)
    pointer(stage, 'pointerup', 1, 150, 120)
    pointer(stage, 'pointerup', 2, 230, 120)
    expect(finish(done)).toEqual({ crop: { x: 200, y: 200, w: 400, h: 400 }, rot: 0 })
  })

  it('offers the shapes, the original and 1:1 included, and keeps to the one chosen', () => {
    const { corner, done } = open()
    const shapes = [...document.querySelectorAll('[role=group][aria-label="Seitenverhältnis"] button')].map((item) => item.textContent?.trim())
    expect(shapes.slice(0, 6)).toEqual(['Frei', 'Original', '4:3', '3:2', '16:9', '1:1'])
    act(() => button('1:1').click())
    expect(button('1:1').getAttribute('aria-pressed')).toBe('true')
    // A square of the 400 by 300 photo: 300 by 300 pixels, in the middle.
    expect(finish(done)).toEqual({ crop: { x: 125, y: 0, w: 750, h: 1000 }, rot: 0 })
    act(() => button('16:9').click())
    expect(finish(done)).toEqual({ crop: { x: 0, y: 125, w: 1000, h: 750 }, rot: 0 })
    // Upright, the same shape stands on its short side.
    act(() => button('Hochformat').click())
    const upright = finish(done).crop!
    expect((upright.w * 400) / (upright.h * 300)).toBeCloseTo(9 / 16, 1)
    // A corner pulled keeps the shape.
    key(corner('se'), 'ArrowLeft', true)
    const after = finish(done).crop!
    expect((after.w * 400) / (after.h * 300)).toBeCloseTo(9 / 16, 1)
    expect(after.w).toBeLessThan(upright.w)
    act(() => button('Original').click())
    expect(finish(done)).toEqual({ crop: null, rot: 0 })
  })

  it('turns in quarter turns and keeps the same part of the photo', () => {
    const { done, out } = open({ crop: { x: 100, y: 200, w: 300, h: 400 }, rot: 0 })
    act(() => button('Drehen').click())
    expect(out.querySelector<HTMLImageElement>('[data-text-crop-stage] img')!.style.transform).toBe('translate(-50%, -50%) rotate(90deg)')
    expect(finish(done)).toEqual({ crop: { x: 400, y: 100, w: 400, h: 300 }, rot: 90 })
    for (let turn = 0; turn < 3; turn++) act(() => button('Drehen').click())
    expect(finish(done)).toEqual({ crop: { x: 100, y: 200, w: 300, h: 400 }, rot: 0 })
  })

  it('works with the keyboard: arrows move, plus and minus resize, a corner moves alone', () => {
    const { cut, corner, done } = open({ crop: { x: 100, y: 100, w: 500, h: 500 }, rot: 0 })
    key(cut(), 'ArrowRight')
    key(cut(), 'ArrowDown', true)
    expect(finish(done)).toEqual({ crop: { x: 110, y: 150, w: 500, h: 500 }, rot: 0 })
    key(cut(), '+')
    expect(finish(done)).toEqual({ crop: { x: 85, y: 125, w: 550, h: 550 }, rot: 0 })
    key(cut(), '-')
    expect(finish(done)).toEqual({ crop: { x: 110, y: 150, w: 500, h: 500 }, rot: 0 })
    key(corner('nw'), 'ArrowUp')
    expect(finish(done)).toEqual({ crop: { x: 110, y: 140, w: 500, h: 510 }, rot: 0 })
    for (const name of ['nw', 'ne', 'sw', 'se']) expect(corner(name).tabIndex).toBe(0)
    expect(cut().tabIndex).toBe(0)
  })

  it('takes everything back on "Zurücksetzen" and hands nothing over on "Abbrechen"', () => {
    const { done, closed } = open({ crop: { x: 100, y: 100, w: 500, h: 500 }, rot: 270 })
    act(() => button('Zurücksetzen').click())
    expect(finish(done)).toEqual({ crop: null, rot: 0 })
    done.mockClear()
    act(() => button('Abbrechen').click())
    expect(closed).toHaveBeenCalled()
    expect(done).not.toHaveBeenCalled()
  })

  it('waits for the photo’s size when the page does not know it', () => {
    const done = vi.fn()
    const out = show(<TextCropDialog src="/x" value={{ crop: null, rot: 90 }} onDone={done} onClose={() => undefined} />)
    expect(out.querySelector('[data-text-crop-stage]')).toBeNull()
    expect(document.body.textContent).toContain('Das Foto wird geladen.')
    expect(button('Fertig').disabled).toBe(true)
    loadInto(out.querySelector('img')!, 300, 400)
    expect(out.querySelector('[data-text-crop-stage]')).not.toBeNull()
    expect(finish(done)).toEqual({ crop: null, rot: 90 })
  })
})
