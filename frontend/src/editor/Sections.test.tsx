/**
 * The editor under a template: every heading of the template has a line to write on, the question of a section is a
 * grey hint in the empty line below its heading (drawn from an attribute, never text of the page and never in the
 * Markdown), and the page counts as empty while it holds nothing but the template's own headings.
 */
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { TemplateSection } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { DiaryEditor, type DiaryEditorHandle } from './DiaryEditor'
import { scaffold, templateOf, untouchedText, withoutEmptySections } from '../lib/templates'
import { eventually, until } from '../test/wait'

let root: Root
let box: HTMLDivElement

const SECTIONS: TemplateSection[] = [
  { heading: 'Heute', question: 'Was war heute los?' },
  { heading: 'Schönes', question: '' },
  { heading: 'Dankbar', question: 'Wofür bin ich dankbar?' },
]

async function show(value: string, options: { sections?: TemplateSection[] | null; onChange?: (markdown: string) => void; onEmpty?: (empty: boolean) => void; handle?: React.RefObject<DiaryEditorHandle | null> } = {}): Promise<HTMLElement> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => {
    root.render(
      <DiaryEditor ref={options.handle} value={value} onChange={options.onChange ?? (() => undefined)} onEmptyChange={options.onEmpty} sections={options.sections} placeholder="Schreib einfach los …" label="Text des Tages" />,
    )
  })
  return await until(() => box.querySelector<HTMLElement>('[contenteditable]'), 'the editor starting')
}

beforeAll(async () => {
  await changeLanguage('de')
  const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect
  Range.prototype.getClientRects ??= (() => []) as unknown as Range['getClientRects']
  Range.prototype.getBoundingClientRect ??= empty
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
})

const FRAME = '## Heute\n\n## Schönes\n\n## Dankbar'

/** The editor's content as the blocks it shows: `h2:Heute`, `p:` for an empty line. */
function blocks(editable: HTMLElement): string[] {
  return [...editable.children].map((node) => `${node.tagName.toLowerCase()}:${node.textContent ?? ''}`)
}

describe('the editor under a template', () => {
  it('gives every heading of the frame a line to write on', async () => {
    const editable = await show(FRAME, { sections: SECTIONS })
    await eventually(() => expect(blocks(editable)).toEqual(['h2:Heute', 'p:', 'h2:Schönes', 'p:', 'h2:Dankbar', 'p:']), 'the lines')
  })

  it('gives a line only to a heading that has none, and only to the headings of the template', async () => {
    const editable = await show('## Heute\n\nSchon etwas.\n\n## Schönes\n\n## Eigenes', { sections: SECTIONS })
    await eventually(() => expect(blocks(editable)).toEqual(['h2:Heute', 'p:Schon etwas.', 'h2:Schönes', 'p:', 'h2:Eigenes']), 'the lines')
  })

  it('shows the question of a section grey in the empty line below its heading, and in no other place', async () => {
    const editable = await show(FRAME, { sections: SECTIONS })
    await eventually(() => expect(editable.querySelectorAll('p.diary-hint')).toHaveLength(2), 'the hints')
    const hints = [...editable.querySelectorAll('p.diary-hint')]
    expect(hints.map((item) => item.getAttribute('data-hint'))).toEqual(['Was war heute los?', 'Wofür bin ich dankbar?'])
    // The hint belongs to the line right below the heading it answers: the second heading has no question, so no hint.
    expect(hints.map((item) => item.previousElementSibling?.textContent)).toEqual(['Heute', 'Dankbar'])
    // It is drawn from an attribute: no text of the page.
    expect(editable.textContent).not.toContain('Was war heute los?')
    expect(editable.textContent).not.toContain('Wofür bin ich dankbar?')
  })

  it('takes the hint away as soon as something is written in the line, and brings it back when it is empty again', async () => {
    const handle = createRef<DiaryEditorHandle>()
    const editable = await show(FRAME, { sections: SECTIONS, handle })
    await eventually(() => expect(editable.querySelectorAll('p.diary-hint')).toHaveLength(2), 'the hints')
    const line = editable.querySelector('p.diary-hint')!
    await act(async () => {
      line.replaceChildren(document.createTextNode('Kastanien gesammelt'))
      await Promise.resolve()
    })
    await eventually(() => expect(editable.querySelectorAll('p.diary-hint')).toHaveLength(1), 'one hint gone')
    expect(editable.textContent).toContain('Kastanien gesammelt')
    await act(async () => {
      editable.querySelectorAll('p')[0].replaceChildren()
      await Promise.resolve()
    })
    await eventually(() => expect(editable.querySelectorAll('p.diary-hint')).toHaveLength(2), 'the hint back')
  })

  it('keeps the hint out of the Markdown, the frame is the same text it began as', async () => {
    const handle = createRef<DiaryEditorHandle>()
    const changes: string[] = []
    const editable = await show(FRAME, { sections: SECTIONS, handle, onChange: (markdown) => changes.push(markdown) })
    await eventually(() => expect(editable.querySelectorAll('p')).toHaveLength(3), 'the lines')
    const markdown = handle.current!.getMarkdown()!
    expect(markdown).not.toContain('Was war heute los?')
    expect(markdown.replace(/\n{3,}/g, '\n\n')).toBe(FRAME)
    expect(changes.every((text) => !text.includes('Was war heute los?'))).toBe(true)
  })

  it('counts as empty while only the headings of the template stand, and not any more when something is written', async () => {
    const empties: boolean[] = []
    const editable = await show(FRAME, { sections: SECTIONS, onEmpty: (empty) => empties.push(empty) })
    await eventually(() => expect(editable.querySelectorAll('p')).toHaveLength(3), 'the lines')
    expect(empties.at(-1)).toBe(true)
    await act(async () => {
      editable.querySelectorAll('p')[1].replaceChildren(document.createTextNode('Schön war es.'))
      await Promise.resolve()
    })
    await eventually(() => expect(empties.at(-1)).toBe(false), 'the page no longer empty')
    await act(async () => {
      editable.querySelectorAll('p')[1].replaceChildren()
      await Promise.resolve()
    })
    await eventually(() => expect(empties.at(-1)).toBe(true), 'the page empty again')
  })

  it('does not count a heading of other words as empty', async () => {
    const empties: boolean[] = []
    await show('## Heute\n\n## Eigenes', { sections: SECTIONS, onEmpty: (empty) => empties.push(empty) })
    await eventually(() => expect(empties.at(-1)).toBe(false), 'a page with a heading of its own')
  })

  it('is the editor it always was without a template: no lines made, no hints, a lone heading is a page', async () => {
    const empties: boolean[] = []
    const editable = await show(FRAME, { onEmpty: (empty) => empties.push(empty) })
    expect(blocks(editable)).toEqual(['h2:Heute', 'h2:Schönes', 'h2:Dankbar'])
    expect(editable.querySelector('.diary-hint')).toBeNull()
    expect(empties.at(-1)).toBe(false)
  })

  it('has no hint and no lines without sections, an empty page is empty', async () => {
    const empties: boolean[] = []
    const editable = await show('', { sections: null, onEmpty: (empty) => empties.push(empty) })
    expect(editable.querySelector('.diary-hint')).toBeNull()
    expect(blocks(editable)).toEqual(['p:'])
    expect(empties.at(-1)).toBe(true)
  })
})

const MARKED = ['C#', 'Plan [A]', 'Dank_ und _mehr', 'a * b', 'Was *wichtig* war', 'Tag & <b>']

describe('the editor under a template with marks of Markdown in its headings', () => {
  const sections: TemplateSection[] = MARKED.map((heading) => ({ heading, question: `Frage zu ${heading}` }))

  it('shows each heading as typed, gives it a line and the hint of its own question', async () => {
    const editable = await show(scaffold(sections), { sections })
    await eventually(() => expect(blocks(editable)).toEqual(MARKED.flatMap((heading) => [`h2:${heading}`, 'p:'])), 'the lines')
    const hints = [...editable.querySelectorAll('p.diary-hint')]
    expect(hints.map((item) => item.getAttribute('data-hint'))).toEqual(sections.map((section) => section.question))
    expect(hints.map((item) => item.previousElementSibling?.textContent)).toEqual(MARKED)
  })

  it('counts as empty with the frame alone and not any more when one section has writing', async () => {
    const empties: boolean[] = []
    const editable = await show(scaffold(sections), { sections, onEmpty: (empty) => empties.push(empty) })
    await eventually(() => expect(editable.querySelectorAll('p')).toHaveLength(MARKED.length), 'the lines')
    expect(empties.at(-1)).toBe(true)
    await act(async () => {
      editable.querySelectorAll('p')[4].replaceChildren(document.createTextNode('Das war wichtig.'))
      await Promise.resolve()
    })
    await eventually(() => expect(empties.at(-1)).toBe(false), 'the page no longer empty')
  })

  it('writes the headings so that they are the same headings again, and the empty ones go on saving', async () => {
    const handle = createRef<DiaryEditorHandle>()
    const editable = await show(scaffold(sections), { sections, handle })
    await eventually(() => expect(editable.querySelectorAll('p')).toHaveLength(MARKED.length), 'the lines')
    await act(async () => {
      editable.querySelectorAll('p')[1].replaceChildren(document.createTextNode('Plan steht.'))
      await Promise.resolve()
    })
    const markdown = handle.current!.getMarkdown()!
    expect(untouchedText(markdown, [{ id: 'x', name: 'x', sections }])).toBe(false)
    expect(withoutEmptySections(markdown, MARKED)).toBe(`## ${markdown.match(/^## (Plan .*)$/m)![1]}\n\nPlan steht.`)
    expect(templateOf(markdown, [{ id: 'x', name: 'x', sections }])?.id).toBe('x')
  })
})

describe('the editor under a template with a backslash in its headings', () => {
  const BS = String.fromCharCode(92)
  const own = [`C:${BS}Users${BS}*`, `a${BS}_b`, `${BS}${BS}`, `a ${BS}#`]
  const sections: TemplateSection[] = own.map((heading) => ({ heading, question: `Frage zu ${heading}` }))

  it('shows each heading as typed, with its line and its hint, and counts the frame as empty', async () => {
    const empties: boolean[] = []
    const editable = await show(scaffold(sections), { sections, onEmpty: (empty) => empties.push(empty) })
    await eventually(() => expect(blocks(editable)).toEqual(own.flatMap((heading) => [`h2:${heading}`, 'p:'])), 'the lines')
    expect([...editable.querySelectorAll('p.diary-hint')].map((item) => item.getAttribute('data-hint'))).toEqual(sections.map((section) => section.question))
    expect(empties.at(-1)).toBe(true)
  })

  it('writes them back as the headings they are, so that the empty ones go on saving', async () => {
    const handle = createRef<DiaryEditorHandle>()
    const editable = await show(scaffold(sections), { sections, handle })
    await eventually(() => expect(editable.querySelectorAll('p')).toHaveLength(own.length), 'the lines')
    await act(async () => {
      editable.querySelectorAll('p')[1].replaceChildren(document.createTextNode('Steht.'))
      await Promise.resolve()
    })
    const markdown = handle.current!.getMarkdown()!
    expect(untouchedText(markdown, [{ id: 'x', name: 'x', sections }])).toBe(false)
    expect(withoutEmptySections(markdown, own).split('\n').filter(Boolean)).toHaveLength(2)
    expect(withoutEmptySections(markdown, own)).toContain('Steht.')
  })
})
