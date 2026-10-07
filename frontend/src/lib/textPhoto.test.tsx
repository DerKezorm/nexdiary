/**
 * A picture inside a page is exactly `![caption](photo:<id>)` on a line of its own at the top of the page, the id of
 * one of the person's own photos. Read, shown, counted and tamed like that, and nothing else is ever a picture: every
 * other form stays the characters it is written with, and no other address is ever loaded.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../i18n'
import { changeLanguage } from '../i18n'
import { Markdown } from '../components/Markdown'
import { flatten, type MdNode } from '../editor/flatten'
import { parseBlocks, plainText, tame, textPhotoIds } from './markdown'

const opened: { photos: { id: string; src: string; caption?: string }[]; index: number; opener: unknown }[] = []
vi.mock('../components/Lightbox', () => ({ useLightbox: () => ({ open: (photos: never[], index: number, opener: unknown) => opened.push({ photos, index, opener }) }) }))

const ID = 'a1'.repeat(16)
const OTHER = '0f'.repeat(16)

let root: Root | null = null
let box: HTMLDivElement | null = null

function show(element: React.ReactNode): HTMLDivElement {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  act(() => root!.render(element))
  return box
}

beforeAll(() => changeLanguage('de', false))

afterEach(() => {
  opened.length = 0
  act(() => root?.unmount())
  box?.remove()
  root = box = null
})

describe('reading a photo in the text', () => {
  it('knows a picture on a line of its own, with its caption', () => {
    expect(parseBlocks(`Vorher.\n\n![Mia am Baum](photo:${ID})\n\nNachher.`).map((block) => block.kind)).toEqual(['paragraph', 'photo', 'paragraph'])
    expect(parseBlocks(`![](photo:${ID})`)).toEqual([{ kind: 'photo', id: ID, caption: '' }])
    expect(parseBlocks(`![Ein \\] Zeichen \\\\ und \\* Stern](photo:${ID})`)).toEqual([{ kind: 'photo', id: ID, caption: 'Ein ] Zeichen \\ und * Stern' }])
    expect(textPhotoIds(`![a](photo:${ID})\n\ntext\n\n![b](photo:${OTHER})\n\n![c](photo:${ID})`)).toEqual([ID, OTHER])
  })

  it.each([
    ['an uppercase id', `![x](photo:${ID.toUpperCase()})`],
    ['a short id', `![x](photo:${ID.slice(1)})`],
    ['a long id', `![x](photo:${ID}0)`],
    ['a query behind the id', `![x](photo:${ID}?a=b)`],
    ['a space before the address', `![x]( photo:${ID})`],
    ['another scheme', `![x](https://example.com/${ID}.png)`],
    ['data', '![x](data:image/png;base64,AAAA)'],
    ['javascript', '![x](javascript:alert(1))'],
    ['an api address', `![x](/api/photos/${ID})`],
    ['words around it', `Vorher ![x](photo:${ID}) nachher`],
    ['a line before it without a blank line', `Zeile\n![x](photo:${ID})`],
    ['a link around it', `[![x](photo:${ID})](https://example.com)`],
    ['in a quote', `> ![x](photo:${ID})`],
    ['in a list', `- ![x](photo:${ID})`],
  ])('does not take %s for a picture', (_name, markdown) => {
    expect(parseBlocks(markdown).some((block) => block.kind === 'photo')).toBe(false)
    expect(textPhotoIds(markdown)).toEqual([])
    const out = show(<Markdown text={markdown} />)
    expect(out.querySelectorAll('img, figure')).toHaveLength(0)
  })

  it('counts no word of the picture and says nothing of it in a short line', () => {
    expect(plainText(`Zwei Worte.\n\n![Eine lange Unterschrift](photo:${ID})\n\nUnd mehr.`)).toBe('Zwei Worte. Und mehr.')
  })

  it('keeps a picture when it tames a long text, and a caption with marks stays one piece', () => {
    const long = `${'*a* '.repeat(1100)}\n\n![Unter *Schrift* \\] ok](photo:${ID})`
    const tamed = tame(long)
    expect(tamed).not.toBe(long)
    expect(textPhotoIds(tamed)).toEqual([ID])
    const [photo] = parseBlocks(tamed).filter((block) => block.kind === 'photo')
    expect(photo).toEqual({ kind: 'photo', id: ID, caption: 'Unter *Schrift* ] ok' })
    expect(tame(`Kurz.\n\n![x](photo:${ID})`)).toBe(`Kurz.\n\n![x](photo:${ID})`)
  })
})

describe('showing a photo in the text', () => {
  it('draws the person’s own photo full width with its caption, from the own route', () => {
    const out = show(<Markdown text={`Text.\n\n![Mia am Baum](photo:${ID})`} />)
    const figure = out.querySelector('figure.diary-photo')!
    const img = figure.querySelector('img')!
    expect(img.getAttribute('src')).toBe(`/api/photos/${ID}`)
    expect(img.getAttribute('alt')).toBe('Mia am Baum')
    expect(figure.querySelector('figcaption')?.textContent).toBe('Mia am Baum')
    expect(out.querySelectorAll('img')).toHaveLength(1)
  })

  it('takes the picture from where the page says (a shared day) and from nowhere else', () => {
    const out = show(<Markdown text={`![x](photo:${ID})\n\n![y](https://example.com/z.png)`} photo={(id) => `/api/shared/3/2026-10-05/photos/${id}`} />)
    expect([...out.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([`/api/shared/3/2026-10-05/photos/${ID}`])
    expect(out.textContent).toContain('![y](https://example.com/z.png)')
  })

  it('shows a quiet word instead of a picture that is gone, never a broken image', () => {
    const out = show(<Markdown text={`![Verloren](photo:${ID})`} />)
    const img = out.querySelector('img')!
    act(() => {
      img.dispatchEvent(new Event('error'))
    })
    expect(out.querySelector('img')).toBeNull()
    expect(out.querySelector('.diary-photo-gone')?.textContent).toContain('Dieses Foto gibt es nicht mehr.')
    expect(out.querySelector('figcaption')?.textContent).toBe('Verloren')
  })

  it('writes a caption as text: no markup, however it is written', () => {
    const out = show(<Markdown text={`![<img src=x onerror="window.__xss=1"> <script>](photo:${ID})`} />)
    expect(out.querySelectorAll('script')).toHaveLength(0)
    expect(out.querySelectorAll('img')).toHaveLength(1)
    expect(out.querySelector('figcaption')?.textContent).toBe('<img src=x onerror="window.__xss=1"> <script>')
    expect((window as { __xss?: number }).__xss).toBeUndefined()
  })
})

describe('the editor’s pass over a page', () => {
  const text = (value: string): MdNode => ({ type: 'text', value })
  const image = (url: string, alt = 'x'): MdNode => ({ type: 'image', url, alt })

  it('makes a paragraph of nothing but a photo a block, and every other picture its words', () => {
    const tree = flatten({
      type: 'root',
      children: [
        { type: 'paragraph', children: [image(`photo:${ID}`, 'Mia')] },
        { type: 'paragraph', children: [text('Davor '), image(`photo:${ID}`, 'mitten')] },
        { type: 'paragraph', children: [image('https://example.com/a.png', 'fremd')] },
        { type: 'paragraph', children: [image(`photo:${ID.toUpperCase()}`, 'gross')] },
        { type: 'blockquote', children: [{ type: 'paragraph', children: [image(`photo:${ID}`, 'zitiert')] }] },
        { type: 'list', ordered: false, children: [{ type: 'listItem', children: [{ type: 'paragraph', children: [image(`photo:${ID}`, 'gelistet')] }] }] },
      ],
    })
    expect(tree.children?.[0]).toEqual({ type: 'diaryPhoto', id: ID, alt: 'Mia' })
    expect(JSON.stringify(tree.children?.slice(1))).not.toContain('diaryPhoto')
    expect(JSON.stringify(tree)).not.toContain('example.com')
    expect(tree.children?.[2]).toEqual({ type: 'paragraph', children: [text('fremd')] })
  })
})

/** The picture's size once it has loaded, as a browser would give it. */
function load(img: HTMLImageElement, width: number, height: number): void {
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true })
  act(() => {
    img.dispatchEvent(new Event('load'))
  })
}

describe('a cut photo in the text', () => {
  it('reads the cut after the id, and only its exact form', () => {
    expect(parseBlocks(`![Mia](photo:${ID}#crop=100,200,300,400&rot=90)`)).toEqual([{ kind: 'photo', id: ID, caption: 'Mia', cut: { crop: { x: 100, y: 200, w: 300, h: 400 }, rot: 90 } }])
    expect(parseBlocks(`![](photo:${ID}#rot=270)`)).toEqual([{ kind: 'photo', id: ID, caption: '', cut: { crop: null, rot: 270 } }])
    // Anything else after the id: the photo, whole.
    for (const fragment of ['#rot=45', '#crop=1,2,3,4', '#crop=1.5,2,30,40', '#crop=-1,2,30,40', '#rot=90&rot=90', '#rot=90&crop=1,2,30,40', '#x=1', '#', `#rot=90${'0'.repeat(70)}`, '#crop=0,0,1000,1000']) {
      expect(parseBlocks(`![x](photo:${ID}${fragment})`), fragment).toEqual([{ kind: 'photo', id: ID, caption: 'x' }])
    }
    expect(textPhotoIds(`![a](photo:${ID}#rot=90)\n\n![b](photo:${ID})`)).toEqual([ID])
  })

  it.each([
    ['a space in it', `![x](photo:${ID}#crop=1, 2,30,40)`],
    ['a bracket in it', `![x](photo:${ID}#crop=(1),2,30,40)`],
    ['far too long', `![x](photo:${ID}#${'a'.repeat(201)})`],
    ['a query before it', `![x](photo:${ID}?a#rot=90)`],
  ])('takes a fragment with %s for no picture, only its characters', (_name, markdown) => {
    expect(parseBlocks(markdown).some((block) => block.kind === 'photo')).toBe(false)
  })

  it('shows the cut out of the original, in the cut’s shape, from numbers only', () => {
    const out = show(<Markdown text={`![Mia](photo:${ID}#crop=500,0,500,1000)`} />)
    const img = out.querySelector<HTMLImageElement>('figure img')!
    // Out of sight until it can be shown cut: the whole picture never flashes up first.
    expect(img.style.visibility).toBe('hidden')
    expect(img.getAttribute('src')).toBe(`/api/photos/${ID}`)
    load(img, 4000, 3000)
    const frame = out.querySelector<HTMLElement>('.diary-photo-cut')!
    expect(frame.style.getPropertyValue('--cut-ratio')).toBe('0.66667')
    expect(img.style.visibility).toBe('')
    expect([img.style.position, img.style.left, img.style.top, img.style.width, img.style.height, img.style.transform]).toEqual(['absolute', '0%', '50%', '200%', '100%', 'translate(-50%, -50%)'])
  })

  it('turns the original around its middle before it cuts', () => {
    const out = show(<Markdown text={`![](photo:${ID}#crop=0,0,1000,500&rot=90)`} />)
    const img = out.querySelector<HTMLImageElement>('figure img')!
    load(img, 4000, 3000)
    expect(out.querySelector<HTMLElement>('.diary-photo-cut')!.style.getPropertyValue('--cut-ratio')).toBe('1.5')
    expect([img.style.left, img.style.top, img.style.width, img.style.height, img.style.transform]).toEqual(['50%', '100%', '133.3333%', '150%', 'translate(-50%, -50%) rotate(90deg)'])
  })

  it('shows a photo without a cut in its own shape and right away', () => {
    const out = show(<Markdown text={`![](photo:${ID})`} />)
    const img = out.querySelector<HTMLImageElement>('figure img')!
    expect(img.getAttribute('style')).toBeNull()
    load(img, 3000, 4000)
    expect(out.querySelector<HTMLElement>('.diary-photo-cut')!.style.getPropertyValue('--cut-ratio')).toBe('0.75')
    expect(img.style.transform).toBe('translate(-50%, -50%)')
  })

  it.each([
    ['a style', `#crop=1,2,30,40");background:url(https://example.com/x)`],
    ['an attribute', `#rot=90"onerror="window.__xss=1`],
    ['a tag', '#rot=90<script>window.__xss=1</script>'],
    ['a custom property', '#--cut-ratio:1;rot=90'],
  ])('never lets %s out of the fragment', (_name, fragment) => {
    const out = show(<Markdown text={`Text.\n\n![x](photo:${ID}${fragment})`} />)
    for (const img of out.querySelectorAll('img')) {
      expect(img.getAttribute('src')).toBe(`/api/photos/${ID}`)
      load(img, 400, 300)
    }
    expect(out.querySelectorAll('script')).toHaveLength(0)
    for (const element of out.querySelectorAll<HTMLElement>('[style]')) expect(element.getAttribute('style')).not.toMatch(/url\(|script|onerror|background/)
    for (const element of out.querySelectorAll('*')) expect(element.getAttributeNames().filter((name) => name.startsWith('on'))).toEqual([])
    expect((window as { __xss?: number }).__xss).toBeUndefined()
  })

  it('opens the big view with every photo of the text, the tapped one first, whole', () => {
    const out = show(<Markdown text={`![Mia](photo:${ID}#rot=90)\n\nText.\n\n![Ben](photo:${OTHER}#crop=0,0,500,500)`} photo={(id) => `/api/shared/3/2026-10-05/photos/${id}`} />)
    const buttons = out.querySelectorAll<HTMLButtonElement>('figure button')
    expect([...buttons].map((button) => button.getAttribute('aria-label'))).toEqual(['Mia', 'Ben'])
    act(() => buttons[1].click())
    expect(opened).toHaveLength(1)
    expect(opened[0].index).toBe(1)
    expect(opened[0].opener).toBe(buttons[1])
    expect(opened[0].photos).toEqual([
      { id: ID, src: `/api/shared/3/2026-10-05/photos/${ID}`, caption: 'Mia', alt: 'Mia' },
      { id: OTHER, src: `/api/shared/3/2026-10-05/photos/${OTHER}`, caption: 'Ben', alt: 'Ben' },
    ])
  })

  it('names a photo without a caption for the big view', () => {
    const out = show(<Markdown text={`![](photo:${ID})`} />)
    expect(out.querySelector('figure button')?.getAttribute('aria-label')).toBe('Foto groß ansehen')
  })

  it('keeps the cut when it tames a long text, in the canonical form, and drops what is not one', () => {
    const long = `${'*a* '.repeat(1100)}\n\n![x](photo:${ID}#crop=1,2,30,40&rot=180)\n\n![y](photo:${OTHER}#rot=45)`
    const tamed = tame(long)
    expect(tamed).toContain(`![x](photo:${ID}#crop=1,2,30,40&rot=180)`)
    expect(tamed).toContain(`![y](photo:${OTHER})`)
    expect(tamed).not.toContain('rot=45')
  })
})

describe('the editor’s pass over a cut photo', () => {
  const image = (url: string, alt = 'x'): MdNode => ({ type: 'image', url, alt })

  it('keeps a canonical cut, drops any other fragment and keeps the photo', () => {
    const tree = flatten({
      type: 'root',
      children: [
        { type: 'paragraph', children: [image(`photo:${ID}#crop=1,2,30,40&rot=90`)] },
        { type: 'paragraph', children: [image(`photo:${ID}#rot=90&crop=1,2,30,40`)] },
        { type: 'paragraph', children: [image(`photo:${ID}#crop=1,2,30,40");background:url(x)`)] },
        { type: 'paragraph', children: [image(`photo:${ID}#`)] },
        { type: 'paragraph', children: [image(`photo:${ID}?x#rot=90`)] },
      ],
    })
    expect(tree.children?.slice(0, 4)).toEqual([
      { type: 'diaryPhoto', id: ID, alt: 'x', cut: 'crop=1,2,30,40&rot=90' },
      { type: 'diaryPhoto', id: ID, alt: 'x' },
      { type: 'diaryPhoto', id: ID, alt: 'x' },
      { type: 'diaryPhoto', id: ID, alt: 'x' },
    ])
    expect(tree.children?.[4]).toEqual({ type: 'paragraph', children: [{ type: 'text', value: 'x' }] })
  })
})
