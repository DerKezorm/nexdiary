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
