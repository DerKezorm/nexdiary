/**
 * The editor as a page sees it: hostile Markdown is shown as text, never as an element; what comes out is Markdown with
 * only the formats of the bar; the bar's buttons format.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../i18n'
import { changeLanguage } from '../i18n'
import { createRef } from 'react'

import { DiaryEditor, type DiaryEditorHandle } from './DiaryEditor'
import { diaryPlugins, filesDropped, onlyFilesPasted, textOnly } from './setup'

let root: Root
let box: HTMLDivElement

async function show(value: string, onChange: (markdown: string) => void = () => undefined, handle = createRef<DiaryEditorHandle>()): Promise<HTMLElement> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => {
    root.render(<DiaryEditor ref={handle} value={value} onChange={onChange} placeholder="Schreib einfach los …" label="Text des Tages" />)
  })
  for (let i = 0; i < 50 && !box.querySelector('[contenteditable]'); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  const editable = box.querySelector<HTMLElement>('[contenteditable]')
  if (!editable) throw new Error('the editor did not start')
  return editable
}

beforeAll(async () => {
  await changeLanguage('de')
  // jsdom lays nothing out: ProseMirror asks a range where the caret is when it scrolls to it after a paste.
  const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect
  Range.prototype.getClientRects ??= (() => []) as unknown as Range['getClientRects']
  Range.prototype.getBoundingClientRect ??= empty
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  delete (window as { __xss?: number }).__xss
})

describe('the editor', () => {
  it('shows hostile Markdown as text, never as an element', async () => {
    const editable = await show(
      'Vorher <img src=x onerror="window.__xss=1"> und [klick](javascript:window.__xss=2) und ![b](http://example.com/p.png)\n\n<script>window.__xss=3</script>\n\n<iframe src="javascript:window.__xss=4"></iframe>',
    )
    expect(editable.querySelectorAll('img, a, script, iframe')).toHaveLength(0)
    expect(editable.textContent).toContain('<img src=x onerror="window.__xss=1">')
    expect(editable.textContent).toContain('klick')
    // No element carries an address: the link lost its target, the picture its source.
    expect(editable.querySelectorAll('[href], [src], [onerror]')).toHaveLength(0)
    expect(editable.textContent).not.toContain('javascript:window.__xss=2')
    expect(editable.textContent).not.toContain('example.com')
    expect((window as { __xss?: number }).__xss).toBeUndefined()
  })

  it('shows the formats of the bar and a heading of any level as a subheading', async () => {
    const editable = await show('# Groß\n\nEin **fetter** und *kursiver* Satz.\n\n> Zitat\n\n- eins\n- zwei')
    expect(editable.querySelectorAll('h1')).toHaveLength(0)
    expect(editable.querySelectorAll('h2')).toHaveLength(1)
    expect(editable.querySelector('strong')?.textContent).toBe('fetter')
    expect(editable.querySelector('em')?.textContent).toBe('kursiver')
    expect(editable.querySelector('blockquote')?.textContent).toBe('Zitat')
    expect(editable.querySelectorAll('ul li')).toHaveLength(2)
  })

  it('names its bar and its text for whoever cannot see them', async () => {
    const editable = await show('')
    expect(editable.getAttribute('aria-label')).toBe('Text des Tages')
    const names = [...box.querySelectorAll('[role=toolbar] button')].map((button) => button.getAttribute('aria-label'))
    expect(names).toEqual(['Fett', 'Kursiv', 'Zwischenüberschrift', 'Zitat', 'Liste', 'Rückgängig'])
    expect(box.textContent).toContain('Schreib einfach los')
  })
  it('takes pasted HTML with the formats of the bar only: a heading becomes a subheading, pictures and links words', async () => {
    let markdown = ''
    const editable = await show('Anfang', (next) => (markdown = next))
    const html = '<h1>Titel</h1><p>ein <b>fetter</b> <a href="javascript:window.__xss=4">Link</a><img src="x" onerror="window.__xss=5"></p><script>window.__xss=6</script>'
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { types: ['text/html', 'text/plain'], files: [], getData: (type: string) => (type === 'text/html' ? html : 'Titel ein fetter Link') },
    })
    await act(async () => {
      editable.focus()
      editable.dispatchEvent(paste)
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    expect(editable.querySelectorAll('h1, img, a, script')).toHaveLength(0)
    expect(editable.querySelectorAll('h2')).toHaveLength(1)
    expect(editable.querySelector('strong')?.textContent).toBe('fetter')
    expect(markdown).toContain('## Titel')
    expect(markdown).not.toContain('javascript')
    expect((window as { __xss?: number }).__xss).toBeUndefined()
  })

  it('gives the text as it stands at once, before its change is reported (a tap on Save right after typing)', async () => {
    const changes: string[] = []
    const handle = createRef<DiaryEditorHandle>()
    await show('Erster Satz.', (next) => changes.push(next), handle)
    act(() => handle.current!.insertHeading('Was war schön?'))
    expect(handle.current!.getMarkdown()).toBe('Erster Satz.\n\n## Was war schön?')
    expect(changes).toEqual([])
    await act(async () => new Promise((resolve) => setTimeout(resolve, 400)))
    expect(changes.at(-1)?.trimEnd()).toBe('Erster Satz.\n\n## Was war schön?')
  })
  it('takes no file pasted or dropped: the browser does not put the picture in either', async () => {
    const editable = await show('Text.')
    const before = editable.innerHTML
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'foto.jpg', { type: 'image/jpeg' })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { types: ['Files'], files: [file], getData: () => '' } })
    await act(async () => {
      editable.focus()
      editable.dispatchEvent(paste)
    })
    expect(paste.defaultPrevented).toBe(true)
    expect(editable.innerHTML).toBe(before)
    // Dropping needs a laid out page to find its place; the rule itself, and that the editor has it:
    expect(filesDropped({ dataTransfer: { files: [file] } as unknown as DataTransfer })).toBe(true)
    expect(filesDropped({ dataTransfer: { files: [] } as unknown as DataTransfer })).toBe(false)
    expect(onlyFilesPasted({ getData: () => 'Wort', files: [file] } as unknown as DataTransfer)).toBe(false)
    expect(diaryPlugins).toContain(textOnly)
  })
})
