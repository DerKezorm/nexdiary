/** The drawn first pages of PDFs: bound to address and size, at most `MAX`, the one seen longest ago goes first. */
import { forgetThumb, forgetThumbs, keepThumb, MAX, thumbCount, thumbOf } from './pdfThumbs'

const picture = (n: number) => ({ picture: `data:image/png;base64,${n}`, pages: n })

beforeEach(forgetThumbs)

it('holds a picture for the same file only: a file replaced under the same address is drawn anew', () => {
  keepThumb('/api/attachments/a', 100, picture(1))
  expect(thumbOf('/api/attachments/a', 100)).toEqual(picture(1))
  expect(thumbOf('/api/attachments/a', 200)).toBeNull()
  keepThumb('/api/attachments/a', 200, picture(2))
  expect(thumbCount()).toBe(1)
})

it('keeps at most MAX, and lets the one seen longest ago go first', () => {
  for (let n = 0; n < MAX; n++) keepThumb(`/f/${n}`, 1, picture(n))
  // Seen again: no longer the oldest.
  expect(thumbOf('/f/0', 1)).not.toBeNull()
  keepThumb('/f/new', 1, picture(99))
  expect(thumbCount()).toBe(MAX)
  expect(thumbOf('/f/0', 1)).not.toBeNull()
  expect(thumbOf('/f/1', 1)).toBeNull()
})

it('forgets one file, or all of them', () => {
  keepThumb('/f/1', 1, picture(1))
  keepThumb('/f/12', 1, picture(2))
  forgetThumb('/f/1')
  expect(thumbOf('/f/1', 1)).toBeNull()
  expect(thumbOf('/f/12', 1)).not.toBeNull()
  forgetThumbs()
  expect(thumbCount()).toBe(0)
})
