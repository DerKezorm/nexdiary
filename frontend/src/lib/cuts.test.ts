/**
 * The numbers of a cut: the fragment of a photo in the text read only in its exact canonical form and written back the
 * same, the cut of a cover checked again, and the styles made of them (numbers, never written text).
 */
import {
  axesOf,
  coverCropOf,
  coverStyle,
  cutFrom,
  cutLayout,
  fitRect,
  formatFragment,
  moveAxis,
  moveRect,
  parseFragment,
  resizeRect,
  scaleRect,
  slopeOf,
  startOf,
  turnRect,
  WHOLE,
  zoomAxis,
  type Rect,
  type TextCut,
} from './textPhoto'

describe('the fragment of a photo in the text', () => {
  it.each([
    ['', { crop: null, rot: 0 }],
    ['crop=100,200,300,400', { crop: { x: 100, y: 200, w: 300, h: 400 }, rot: 0 }],
    ['rot=90', { crop: null, rot: 90 }],
    ['rot=270', { crop: null, rot: 270 }],
    ['crop=0,0,1000,10&rot=180', { crop: { x: 0, y: 0, w: 1000, h: 10 }, rot: 180 }],
    ['crop=990,990,10,10', { crop: { x: 990, y: 990, w: 10, h: 10 }, rot: 0 }],
  ])('reads %j', (fragment, cut) => {
    expect(parseFragment(fragment)).toEqual(cut)
    // And writes it back exactly so.
    expect(formatFragment(cut as TextCut)).toBe(fragment ? `#${fragment}` : '')
  })

  it.each([
    ['another key', 'zoom=2'],
    ['another key beside', 'crop=1,2,30,40&x=1'],
    ['the turn first', 'rot=90&crop=1,2,30,40'],
    ['a cut twice', 'crop=1,2,30,40&crop=1,2,30,40'],
    ['a turn twice', 'rot=90&rot=90'],
    ['three parts', 'crop=1,2,30,40&rot=90&rot=90'],
    ['a turn of nothing', 'rot=0'],
    ['a turn of 45', 'rot=45'],
    ['a turn of 360', 'rot=360'],
    ['a leading zero', 'crop=01,2,30,40'],
    ['a decimal', 'crop=1.5,2,30,40'],
    ['a sign', 'crop=-1,2,30,40'],
    ['a plus', 'crop=+1,2,30,40'],
    ['a space', 'crop=1, 2,30,40'],
    ['a trailing space', 'rot=90 '],
    ['three numbers', 'crop=1,2,30'],
    ['five numbers', 'crop=1,2,30,40,50'],
    ['an empty number', 'crop=,2,30,40'],
    ['a side too small', 'crop=0,0,9,40'],
    ['beyond the right edge', 'crop=500,0,501,40'],
    ['beyond the bottom', 'crop=0,991,40,10'],
    ['a number too large', 'crop=0,0,1001,40'],
    ['the whole photo (written as nothing)', 'crop=0,0,1000,1000'],
    ['an empty part', 'crop=1,2,30,40&'],
    ['only an ampersand', '&'],
    ['a capital key', 'CROP=1,2,30,40'],
    ['a script', 'crop=1,2,30,40&rot=90;<script>'],
    ['a style', 'crop=1,2,30,40");background:url(x'],
    ['too long', `crop=1,2,30,40&rot=90${'0'.repeat(60)}`],
    ['a long number', 'crop=00000000000000000001,2,30,40'],
  ])('reads %s as no cut', (_name, fragment) => {
    expect(parseFragment(fragment)).toBeNull()
  })

  it('writes the canonical form only: no whole cut, no turn of nothing, never a broken rectangle', () => {
    expect(formatFragment({ crop: { x: 0, y: 0, w: 1000, h: 1000 }, rot: 0 })).toBe('')
    expect(formatFragment({ crop: { x: 0, y: 0, w: 1000, h: 1000 }, rot: 90 })).toBe('#rot=90')
    expect(formatFragment({ crop: { x: 1.5, y: 0, w: 10, h: 10 }, rot: 0 })).toBe('')
    expect(formatFragment({ crop: { x: 995, y: 0, w: 10, h: 10 }, rot: 0 })).toBe('')
    expect(formatFragment(null)).toBe('')
    expect(formatFragment({ crop: null, rot: 45 as never })).toBe('')
  })

  it('makes whole thousandths of a cut being edited, inside the photo', () => {
    expect(cutFrom({ x: 10.4, y: 20.6, w: 300.5, h: 400.4 }, 90)).toEqual({ crop: { x: 10, y: 21, w: 301, h: 400 }, rot: 90 })
    expect(cutFrom({ x: 999.7, y: 0, w: 0.4, h: 50 }, 0)).toEqual({ crop: { x: 990, y: 0, w: 10, h: 50 }, rot: 0 })
    expect(cutFrom({ x: 600.2, y: 0, w: 400, h: 1000 }, 0).crop).toEqual({ x: 600, y: 0, w: 400, h: 1000 })
    expect(cutFrom({ x: 0.3, y: 0.2, w: 999.8, h: 1000 }, 0)).toEqual({ crop: null, rot: 0 })
    for (const rect of [{ x: 0, y: 0, w: 1000, h: 1000 }, { x: 333.3, y: 0, w: 666.7, h: 1000 }, { x: 0.5, y: 999.4, w: 1000, h: 0.6 }]) {
      const fragment = formatFragment(cutFrom(rect, 270))
      expect(parseFragment(fragment.slice(1))).not.toBeNull()
    }
  })
})

describe('the cut of a cover', () => {
  it('takes exactly three whole numbers in their ranges', () => {
    expect(coverCropOf({ x: 0, y: 1000, zoom: 400 })).toEqual({ x: 0, y: 1000, zoom: 400 })
    expect(coverCropOf({ zoom: 100, y: 5, x: 7 })).toEqual({ x: 7, y: 5, zoom: 100 })
    for (const bad of [null, undefined, 'x', 3, [], { x: 1, y: 2 }, { x: 1, y: 2, zoom: 100, more: 1 }, { x: -1, y: 2, zoom: 100 }, { x: 1001, y: 2, zoom: 100 }, { x: 1, y: 2, zoom: 99 }, { x: 1, y: 2, zoom: 401 }, { x: 1.5, y: 2, zoom: 100 }, { x: '1', y: 2, zoom: 100 }, { x: Number.NaN, y: 2, zoom: 100 }]) {
      expect(coverCropOf(bad)).toBeNull()
    }
  })

  it('makes a style of numbers: the point held, the zoom around it', () => {
    expect(coverStyle({ x: 250, y: 705, zoom: 150 })).toEqual({ objectPosition: '25% 70.5%', transform: 'scale(1.5)', transformOrigin: '25% 70.5%' })
    expect(coverStyle({ x: 500, y: 500, zoom: 100 })).toEqual({ objectPosition: '50% 50%' })
    expect(coverStyle(null)).toEqual({})
    // Whatever came instead of numbers never becomes a style.
    expect(coverStyle({ x: '1%;background:url(x)', y: 2, zoom: 100 } as never)).toEqual({})
    expect(coverStyle({ x: 1, y: 2, zoom: 100, extra: 'red' } as never)).toEqual({})
  })

  it('moves the photo with the finger and never leaves a gap', () => {
    // A frame of 200 by 100 and a photo of 300 by 300: filling the frame it is 200 by 200, at twice the zoom 400.
    const [across, down] = axesOf(200, 100, 300, 300)
    expect(across).toEqual({ frame: 200, base: 200 })
    expect(down).toEqual({ frame: 100, base: 200 })
    // Across there is no room at zoom 1: the point stays.
    expect(moveAxis(across, 0.5, 1, 40)).toBe(0.5)
    // Down the photo is 100 longer: moving it down 50 from the middle shows its top.
    expect(moveAxis(down, 0.5, 1, 50)).toBe(0)
    expect(moveAxis(down, 0.5, 1, -50)).toBe(1)
    expect(moveAxis(down, 0.5, 1, 25)).toBeCloseTo(0.25)
    // Further than the edge it does not go.
    expect(moveAxis(down, 0.5, 1, 500)).toBe(0)
    expect(startOf(down, moveAxis(down, 0.5, 1, 10), 1)).toBeCloseTo(startOf(down, 0.5, 1) + 10)
    // At twice the zoom it moves across too, exactly as far as the finger.
    const at = moveAxis(across, 0.5, 2, 30)
    expect(startOf(across, at, 2)).toBeCloseTo(startOf(across, 0.5, 2) + 30)
  })

  it('zooms around a place of the frame: what stood there stays there', () => {
    const [across] = axesOf(200, 100, 300, 300)
    const place = 50
    const before = (place - startOf(across, 0.5, 1)) / (across.base * 1)
    const at = zoomAxis(across, 0.5, 1, 2, place)
    const after = (place - startOf(across, at, 2)) / (across.base * 2)
    expect(after).toBeCloseTo(before)
    // Back to just filling, the point no longer matters across and stays.
    expect(zoomAxis(across, at, 2, 1, place)).toBe(at)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(at).toBeLessThanOrEqual(1)
  })
})

describe('showing a cut photo of the text', () => {
  it('frames the cut in its own shape and places the whole original in it', () => {
    // 4000 by 3000, the right half: 2000 by 3000, two to three.
    const layout = cutLayout(4000, 3000, { crop: { x: 500, y: 0, w: 500, h: 1000 }, rot: 0 })!
    expect(layout.ratio).toBeCloseTo(2 / 3)
    expect(layout.img).toMatchObject({ position: 'absolute', left: '0%', top: '50%', width: '200%', height: '100%', transform: 'translate(-50%, -50%)', maxWidth: 'none' })
  })

  it('turns first, then cuts, around the picture’s middle', () => {
    // 4000 by 3000 turned a quarter is 3000 by 4000; its top half is 3000 by 2000.
    const layout = cutLayout(4000, 3000, { crop: { x: 0, y: 0, w: 1000, h: 500 }, rot: 90 })!
    expect(layout.ratio).toBeCloseTo(1.5)
    // The picture itself stays 4000 by 3000: in the frame of 3000 by 2000 that is 133.33 % across and 150 % down.
    expect(layout.img).toMatchObject({ left: '50%', top: '100%', width: '133.3333%', height: '150%', transform: 'translate(-50%, -50%) rotate(90deg)' })
    const half = cutLayout(4000, 3000, { crop: null, rot: 180 })!
    expect(half.ratio).toBeCloseTo(4 / 3)
    expect(half.img).toMatchObject({ left: '50%', top: '50%', width: '100%', height: '100%', transform: 'translate(-50%, -50%) rotate(180deg)' })
  })

  it('knows nothing while the photo’s size is unknown or unusable', () => {
    for (const [w, h] of [[0, 3], [3, 0], [Number.NaN, 3], [Number.POSITIVE_INFINITY, 3], [-1, 3]]) expect(cutLayout(w, h, { crop: null, rot: 0 })).toBeNull()
    // A broken cut shows the whole photo.
    expect(cutLayout(4, 3, { crop: { x: 900, y: 0, w: 500, h: 10 }, rot: 0 })!.ratio).toBeCloseTo(4 / 3)
  })
})

describe('cutting in the editor', () => {
  const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h })

  it('moves the cut inside the photo only', () => {
    expect(moveRect(rect(100, 100, 200, 200), 50, -30)).toEqual(rect(150, 70, 200, 200))
    expect(moveRect(rect(100, 100, 200, 200), 5000, -5000)).toEqual(rect(800, 0, 200, 200))
  })

  it('takes a corner along, the opposite one holding still, freely or in a shape', () => {
    expect(resizeRect(rect(100, 100, 400, 400), 'se', { x: 700, y: 300 }, null)).toEqual(rect(100, 100, 600, 200))
    expect(resizeRect(rect(100, 100, 400, 400), 'nw', { x: 300, y: 50 }, null)).toEqual(rect(300, 50, 200, 450))
    // Past the edge it stops there; past the opposite corner it keeps the smallest side.
    expect(resizeRect(rect(100, 100, 400, 400), 'se', { x: 2000, y: 2000 }, null)).toEqual(rect(100, 100, 900, 900))
    expect(resizeRect(rect(100, 100, 400, 400), 'se', { x: 0, y: 0 }, null)).toEqual(rect(100, 100, 60, 60))
    // In a shape of twice as wide as high (in thousandths): the larger wish, as much as fits.
    const shaped = resizeRect(rect(100, 100, 400, 200), 'se', { x: 900, y: 150 }, 0.5)
    expect(shaped.w).toBeCloseTo(800)
    expect(shaped.h).toBeCloseTo(400)
    // The side that changed leads: a corner taken left only makes the shape smaller.
    const narrower = resizeRect(rect(100, 100, 400, 200), 'se', { x: 400, y: 300 }, 0.5)
    expect(narrower.w).toBeCloseTo(300)
    expect(narrower.h).toBeCloseTo(150)
    const capped = resizeRect(rect(100, 100, 400, 200), 'se', { x: 2000, y: 2000 }, 0.5)
    expect(capped.x + capped.w).toBeLessThanOrEqual(1000.0001)
    expect(capped.h / capped.w).toBeCloseTo(0.5)
  })

  it('grows and shrinks around its middle, in its shape', () => {
    const grown = scaleRect(rect(400, 400, 200, 100), 2, 0.5)
    expect(grown).toEqual(rect(300, 350, 400, 200))
    const huge = scaleRect(rect(400, 400, 200, 100), 50, 0.5)
    expect(huge.w).toBeCloseTo(1000)
    expect(huge.h).toBeCloseTo(500)
    expect(scaleRect(rect(400, 400, 200, 100), 0.01, null).w).toBeGreaterThanOrEqual(60)
  })

  it('fits a shape as large as it goes and keeps the same part when turned', () => {
    // The photo is 4:3, a square is 0.75 of its width.
    const square = fitRect(WHOLE, slopeOf(1, 4 / 3))
    expect(square.w).toBeCloseTo(750)
    expect(square.h).toBeCloseTo(1000)
    expect(square.x).toBeCloseTo(125)
    expect(turnRect(rect(100, 200, 300, 400))).toEqual(rect(400, 100, 400, 300))
    // Four quarter turns are where it began.
    expect(turnRect(turnRect(turnRect(turnRect(rect(100, 200, 300, 400)))))).toEqual(rect(100, 200, 300, 400))
  })
})
