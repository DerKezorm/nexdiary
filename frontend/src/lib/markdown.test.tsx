/**
 * A page shown: the forms the editor writes come out as the elements the editor showed, and nothing a person typed
 * ever becomes markup (a script, a picture, a link stay the characters they were written with).
 */
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../i18n'
import { Markdown } from '../components/Markdown'
import { DiaryEditor, type DiaryEditorHandle } from '../editor/DiaryEditor'
import { until } from '../test/wait'
import { MAX_DEPTH, MAX_MARKS, parseBlocks, plainText, tame, type Inline } from './markdown'

let root: Root
let box: HTMLDivElement

function render(text: string): HTMLElement {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  act(() => root.render(<Markdown text={text} />))
  return box.firstElementChild as HTMLElement
}

/** The shape of a tree of elements: tag names and the text of the leaves, nothing of attributes or classes. A span
 * counts as its text (the editor shows a line end inside a paragraph as a space in a span of its own). */
function shape(element: Element): unknown {
  const children: unknown[] = []
  for (const node of element.childNodes) {
    let part: unknown = null
    if (node.nodeType === Node.TEXT_NODE) part = node.textContent || null
    else if (node instanceof HTMLElement && node.classList.contains('ProseMirror-trailingBreak')) part = null
    else if (node instanceof HTMLElement && node.tagName === 'SPAN') part = node.textContent || null
    else if (node instanceof Element) part = shape(node)
    if (part === null) continue
    if (typeof part === 'string' && typeof children.at(-1) === 'string') children[children.length - 1] += part
    else children.push(part)
  }
  return { [element.tagName.toLowerCase()]: children }
}

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  delete (window as { __xss?: number }).__xss
})

describe('a page shown', () => {
  it('has paragraphs, subheadings, quotes, lists, bold, italic and line breaks', () => {
    const page = render('## Morgens\n\nErster **fetter** und *kursiver* Satz.\\\nZweite Zeile.\n\n> Ein Zitat\n> geht weiter.\n\n* eins\n* zwei\n\n3. drei\n4. vier\n\nEnde_mit_Strich und \\*Sterne\\*.')
    expect(page.querySelector('h2')?.textContent).toBe('Morgens')
    expect(page.querySelector('strong')?.textContent).toBe('fetter')
    expect(page.querySelector('em')?.textContent).toBe('kursiver')
    expect(page.querySelectorAll('br')).toHaveLength(1)
    expect(page.querySelector('blockquote')?.textContent).toBe('Ein Zitat geht weiter.')
    expect([...page.querySelectorAll('ul > li')].map((item) => item.textContent)).toEqual(['eins', 'zwei'])
    expect(page.querySelector('ol')?.getAttribute('start')).toBe('3')
    expect([...page.querySelectorAll('ol > li')].map((item) => item.textContent)).toEqual(['drei', 'vier'])
    expect(page.lastElementChild?.textContent).toBe('Ende_mit_Strich und *Sterne*.')
    expect(page.className).toBe('prose-diary')
  })

  it('keeps lists inside lists and paragraphs inside items', () => {
    const blocks = parseBlocks('- oben\n  - drunter\n  - auch\n- wieder oben')
    expect(blocks).toHaveLength(1)
    const page = render('- oben\n  - drunter\n  - auch\n- wieder oben')
    expect(page.querySelectorAll('ul ul > li')).toHaveLength(2)
    expect(page.querySelectorAll(':scope > ul > li')).toHaveLength(2)
  })

  it('never makes markup of what was typed', () => {
    const hostile = [
      '<img src=x onerror="window.__xss=1">',
      '<script>window.__xss=2</script>',
      '[klick](javascript:window.__xss=3)',
      '![bild](https://example.com/x.png)',
      '<a href="javascript:window.__xss=4">a</a>',
      '**<b onmouseover="window.__xss=5">fett</b>**',
      '`<i>code</i>`',
    ].join('\n\n')
    const page = render(hostile)
    expect(page.querySelectorAll('img, script, a, b, i, iframe, svg, code')).toHaveLength(0)
    expect(page.textContent).toContain('<img src=x onerror="window.__xss=1">')
    expect(page.textContent).toContain('<script>window.__xss=2</script>')
    expect(page.textContent).toContain('[klick](javascript:window.__xss=3)')
    expect(page.querySelector('strong')?.textContent).toBe('<b onmouseover="window.__xss=5">fett</b>')
    expect((window as { __xss?: number }).__xss).toBeUndefined()
    expect(page.innerHTML).not.toMatch(/<(img|script|a|b|i)[\s>]/)
  })

  it('shows unclosed marks as the characters they are', () => {
    const page = render('ein *halber und ein ** Rest_')
    expect(page.querySelectorAll('strong, em')).toHaveLength(0)
    expect(page.textContent).toBe('ein *halber und ein ** Rest_')
  })

  it('gives plain words for a list', () => {
    expect(plainText('## Titel\n\n> **Fett** und *kursiv*\n\n- a\n- b')).toBe('Titel Fett und kursiv a b')
  })
})

/** The best of three runs, in milliseconds: a test machine busy with other tests at that moment does not count. */
function fastest(run: () => unknown): number {
  let best = Infinity
  for (let round = 0; round < 3; round++) {
    const started = performance.now()
    run()
    best = Math.min(best, performance.now() - started)
  }
  return best
}

describe('a hostile page', () => {
  /** 100 KB each, the largest a page may be: every one is read in a time nobody notices, and none breaks it. */
  const SIZE = 100_000
  const PATHOLOGIES: [string, string][] = [
    ['*a ', '*a '.repeat(SIZE / 3)],
    ['_a ', '_a '.repeat(SIZE / 3)],
    ['**a ', '**a '.repeat(SIZE / 4)],
    ['***a ', '***a '.repeat(SIZE / 5)],
    ['> deep', '>'.repeat(SIZE)],
    ['> spaced', '> '.repeat(SIZE / 2)],
    ['> a', '> a'.repeat(SIZE / 3)],
    ['lines of > a', '> a\n'.repeat(SIZE / 4)],
    ['- nested', Array.from({ length: 2000 }, (_, i) => ' '.repeat(Math.min(i * 2, 100)) + '- x').join('\n')],
    ['lines', 'a\n'.repeat(SIZE / 2)],
    ['*_ nested', '*_'.repeat(SIZE / 4) + '_*'.repeat(SIZE / 4)],
    ['*a*a', '*a'.repeat(SIZE / 2)],
  ]

  it.each(PATHOLOGIES)('reads %s quickly and whole', (_name, text) => {
    expect(fastest(() => parseBlocks(text) && plainText(text))).toBeLessThan(200)
    expect(parseBlocks(text).length).toBeGreaterThan(0)
  })

  it.each(PATHOLOGIES)('is tamed for the editor: %s', (_name, text) => {
    expect(fastest(() => tame(text))).toBeLessThan(400)
    const tamed = tame(text)
    const marks = [...tamed.replace(/\\./g, '')].filter((char) => char === '*' || char === '_').length
    expect(marks).toBeLessThanOrEqual(MAX_MARKS)
    // Read again, it stays within the limits: nothing deeper, so it comes back the same.
    expect(tame(tamed)).toBe(tamed)
  })

  it('never nests bold and italic deeper than there are kinds of marks', () => {
    const depth = (nodes: Inline[]): number => Math.max(0, ...nodes.map((node) => (node.kind === 'strong' || node.kind === 'em' ? 1 + depth(node.children) : 0)))
    const levels = 3000
    const marks = ['*', '_', '**', '__']
    const open = Array.from({ length: levels }, (_, i) => marks[i % 4] + 'w').join(' ')
    const close = Array.from({ length: levels }, (_, i) => 'w' + marks[(levels - 1 - i) % 4]).join(' ')
    for (const text of [open + ' ' + close, '*_'.repeat(SIZE / 4) + '_*'.repeat(SIZE / 4), '**__'.repeat(SIZE / 8) + '__**'.repeat(SIZE / 8)]) {
      const found = parseBlocks(text).flatMap((block) => (block.kind === 'paragraph' ? [depth(block.children)] : []))
      expect(Math.max(...found)).toBeLessThanOrEqual(4)
    }
  })

  it('nests quotes only so deep, the rest stays text', () => {
    const page = render('>'.repeat(SIZE))
    expect(page.querySelectorAll('blockquote')).toHaveLength(MAX_DEPTH)
    expect(page.textContent).toBe('>'.repeat(SIZE - MAX_DEPTH))
  })
})

describe('what the editor writes', () => {
  beforeAll(() => {
    const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect
    Range.prototype.getClientRects ??= (() => []) as unknown as Range['getClientRects']
    Range.prototype.getBoundingClientRect ??= empty
  })

  it('is shown as the editor showed it', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const source = [
      '# Ein Tag am See',
      'Morgens **früh** los, *ganz* ruhig. Ein Satz mit * Stern und _ Strich, snake_case und 3 * 4.',
      '> Nichts vorhaben\n> ist auch ein Plan.',
      '- Brot\n- Käse\n  - alt\n  - jung\n- Äpfel',
      '1. erst\n2. dann',
      'Zeile eins  \nZeile zwei',
      '<b>kein html</b> und [kein](https://example.com) Link',
    ].join('\n\n')
    const editorBox = document.createElement('div')
    document.body.appendChild(editorBox)
    const editorRoot = createRoot(editorBox)
    const handle = createRef<DiaryEditorHandle>()
    await act(async () => {
      editorRoot.render(<DiaryEditor ref={handle} value={source} onChange={() => undefined} placeholder="" label="Text" />)
    })
    const editable = await until(() => editorBox.querySelector<HTMLElement>('[contenteditable]'), 'the editor starting')
    const written = handle.current!.getMarkdown()!
    expect(written).toBeTruthy()
    expect(tame(written)).toBe(written)
    const page = render(written)
    expect(shape(page)).toEqual({ div: (shape(editable) as { div: unknown[] }).div })
    // Floor: the comparison sees the structure at all.
    expect(page.querySelectorAll('h2, strong, em, blockquote, ul ul, ol, br').length).toBeGreaterThanOrEqual(7)
    act(() => editorRoot.unmount())
    editorBox.remove()
  })

  it('opens a text made to break it, quickly, as deep as a page may go', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const editorBox = document.createElement('div')
    document.body.appendChild(editorBox)
    const editorRoot = createRoot(editorBox)
    const started = performance.now()
    await act(async () => {
      editorRoot.render(<DiaryEditor value={'>'.repeat(20_000) + '\n\n' + '*_'.repeat(3000)} onChange={() => undefined} placeholder="" label="Text" />)
    })
    await until(() => editorBox.querySelector('[contenteditable]'), 'the editor starting')
    // Without taming it, remark needs half a minute here or overflows its stack; with it, about one second.
    expect(performance.now() - started).toBeLessThan(8000)
    expect(editorBox.querySelectorAll('blockquote').length).toBeLessThanOrEqual(MAX_DEPTH)
    act(() => editorRoot.unmount())
    editorBox.remove()
  }, 30_000)
})
