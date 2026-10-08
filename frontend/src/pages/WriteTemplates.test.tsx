/**
 * Writing a day up under a template, against a server stand-in: the line "Vorlage" is there only for a person with
 * templates and only while the page is empty or holds the unchanged frame of a template; the default one is preselected;
 * its headings stand in the text with a line each and the question as a grey hint that is not in the Markdown; a frame
 * alone makes no draft and cannot be saved; another choice swaps the frame; the AI buttons carry the template; and on
 * saving the sections that stayed empty fall away while every other heading and all that is written stays.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import '../i18n'
import { changeLanguage } from '../i18n'
import WritePage from './WritePage'
import { eventually, idle, until } from '../test/wait'

vi.mock('../state/auth', () => ({
  useAuth: () => ({ me: { name: 'jule', display_name: 'Jule', profile: { mode: 'light', layout: 'page', quick_start: false, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'manual' } } }),
}))

const DATE = '2026-10-06'
type Section = { heading: string; question: string }
type Template = { id: string; name: string; sections: Section[] }
type Call = { method: string; url: string; body: Record<string, unknown> | undefined }

const REVIEW: Template = {
  id: 'aaaaaaaaaaaa',
  name: 'Tagesrückblick',
  sections: [
    { heading: 'Heute', question: 'Was war heute los?' },
    { heading: 'Schönes', question: 'Was war schön?' },
    { heading: 'Dankbar', question: '' },
  ],
}
const WORK: Template = { id: 'bbbbbbbbbbbb', name: 'Arbeitstag', sections: [{ heading: 'Gearbeitet', question: 'Woran habe ich gearbeitet?' }, { heading: 'Gehakt', question: '' }] }

let calls: Call[] = []
let set: { templates: Template[]; default: string | null; revision: number }
let day: Record<string, unknown> | null = null
let draft: Record<string, unknown> | null = null
let dayNotes: Record<string, unknown>[] = []
let suggestion: { title: string; text: string } = { title: 'Kastanien', text: '## Heute\n\nMit Mia Kastanien gesammelt.\n\n## Schönes\n\n## Dankbar' }

function page(fields: Record<string, unknown>): Record<string, unknown> {
  return { date: DATE, title: '', text: '', tags: [], values: {}, cover: 'illu:baum.abend.herbst', cover_chosen: false, written_by: 'self', words: 0, revision: 0, created_at: '', updated_at: '2026-10-06T17:00:00+00:00', ...fields }
}

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/templates') return json(set)
      if (url === `/api/days/${DATE}/draft`) {
        if (method === 'PUT') {
          draft = { ...body, updated_at: '2026-10-06T17:30:00+00:00' }
          return json(draft)
        }
        if (method === 'DELETE') {
          draft = null
          return new Response(null, { status: 204 })
        }
        return json(draft)
      }
      if (url === `/api/days/${DATE}`) {
        if (method === 'PUT') {
          const { base_revision: _base, ...fields } = body!
          day = page({ ...(day ?? {}), ...fields, revision: ((day?.revision as number | undefined) ?? -1) + 1, cover_chosen: true })
          draft = null
          return json(day)
        }
        return day ? json(day) : json({ detail: { code: 'not_found', message: 'x' } }, 404)
      }
      if (url === '/api/ai/formulate') return json({ ...suggestion, length: body!.length })
      if (url === '/api/ai') return json({ provider: 'local', to: '', model: 'llama3.1:8b', mine: true, available: true })
      if (url.startsWith('/api/prompts/pool')) return json({ questions: [] })
      if (url.startsWith('/api/notes')) return json(dayNotes)
      if (url.startsWith('/api/photos')) return json([])
      if (url.startsWith('/api/today')) return json({ date: DATE, notes: [], day, values: [], streak: 5, photos: [] })
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function show(state: unknown = null): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[{ pathname: `/tag/${DATE}/schreiben`, state }]}>
        <Routes>
          <Route path="/tag/:date/schreiben" element={<WritePage />} />
          <Route path="*" element={<p>woanders</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await until(() => box.querySelector('[contenteditable]'), 'the page opening')
  await idle()
}

/** Closes the page and opens it anew on a server without a draft (leaving a page sends what was typed as a draft). */
async function reopen(): Promise<void> {
  act(() => root.unmount())
  box.remove()
  draft = null
  await show()
}

const editable = () => box.querySelector<HTMLElement>('[contenteditable]')!
const row = () => box.querySelector<HTMLElement>('[data-template-row]')
const picker = () => row()?.querySelector('select') ?? null
/** The blocks of the text as the editor shows them: `h2:Heute`, `p:` for an empty line. */
const blocks = () => [...editable().children].map((node) => `${node.tagName.toLowerCase()}:${node.textContent ?? ''}`)
const puts = () => calls.filter((call) => call.method === 'PUT' && call.url === `/api/days/${DATE}`)
const drafts = () => calls.filter((call) => call.method === 'PUT' && call.url.endsWith('/draft'))
const asked = () => calls.filter((call) => call.url === '/api/ai/formulate')

function saveButtons(): HTMLButtonElement[] {
  return [...box.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent?.includes('Speichern') && !item.textContent.includes('Fassung'))
}

function button(text: string): HTMLButtonElement {
  return [...box.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)!
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await idle()
}

/** Text typed into the empty line number `index` (counting the lines of the editor), the way the browser puts it there. */
async function typeInLine(index: number, text: string): Promise<void> {
  const line = editable().querySelectorAll('p')[index]
  await act(async () => {
    line.replaceChildren(document.createTextNode(text))
    await Promise.resolve()
  })
}

function type(field: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeAll(() => {
  const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect
  Range.prototype.getClientRects ??= (() => []) as unknown as Range['getClientRects']
  Range.prototype.getBoundingClientRect ??= empty
})

beforeEach(async () => {
  await changeLanguage('de', false)
  set = { templates: [REVIEW, WORK], default: REVIEW.id, revision: 2 }
  day = null
  draft = null
  dayNotes = []
  suggestion = { title: 'Kastanien', text: '## Heute\n\nMit Mia Kastanien gesammelt.\n\n## Schönes\n\n## Dankbar' }
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('the line "Vorlage"', () => {
  it('is not there for a person without templates, and the page is as it always was', async () => {
    set = { templates: [], default: null, revision: -1 }
    await show()
    expect(row()).toBeNull()
    expect(blocks()).toEqual(['p:'])
    expect(box.textContent).toContain('Schreib einfach los')
  })

  it('is there on an empty page with the default template chosen and its frame in the text', async () => {
    await show()
    expect(row()!.textContent).toContain('Vorlage')
    expect([...picker()!.options].map((option) => option.textContent)).toEqual(['Ohne Vorlage', 'Tagesrückblick', 'Arbeitstag'])
    expect(picker()!.value).toBe(REVIEW.id)
    expect(row()!.textContent).toContain('Leere Abschnitte fallen beim Speichern weg.')
    await eventually(() => expect(blocks()).toEqual(['h2:Heute', 'p:', 'h2:Schönes', 'p:', 'h2:Dankbar', 'p:']), 'the frame')
  })

  it('preselects nothing where there is no default, and the page is empty', async () => {
    set = { ...set, default: null }
    await show()
    expect(picker()!.value).toBe('')
    expect(blocks()).toEqual(['p:'])
    expect(row()!.textContent).not.toContain('Leere Abschnitte fallen beim Speichern weg.')
  })

  it('shows the question of each section as a hint in the line below its heading, not as text', async () => {
    await show()
    await eventually(() => expect(editable().querySelectorAll('p.diary-hint')).toHaveLength(2), 'the hints')
    expect([...editable().querySelectorAll('p.diary-hint')].map((item) => item.getAttribute('data-hint'))).toEqual(['Was war heute los?', 'Was war schön?'])
    expect(editable().textContent).not.toContain('Was war heute los?')
  })

  it('swaps the frame when another template is chosen, and takes it away for "Ohne Vorlage", without a draft', async () => {
    await show()
    await choose(picker()!, WORK.id)
    await eventually(() => expect(blocks()).toEqual(['h2:Gearbeitet', 'p:', 'h2:Gehakt', 'p:']), 'the other frame')
    expect(picker()!.value).toBe(WORK.id)
    await choose(picker()!, '')
    await eventually(() => expect(blocks()).toEqual(['p:']), 'the plain page')
    expect(box.textContent).toContain('Schreib einfach los')
    expect(row()!.textContent).not.toContain('Leere Abschnitte fallen beim Speichern weg.')
    await choose(picker()!, REVIEW.id)
    await eventually(() => expect(blocks()).toHaveLength(6), 'the first frame again')
    await reopen()
    expect(drafts()).toEqual([])
    expect(puts()).toEqual([])
  })

  it('goes once something is written, and for a page that has a text already', async () => {
    await show()
    await typeInLine(0, 'Kastanien gesammelt')
    await eventually(() => expect(row()).toBeNull(), 'the line going')
    day = page({ title: 'Ein Tag', text: 'Der Text des Tages.', revision: 1 })
    await reopen()
    expect(row()).toBeNull()
    expect(blocks()).toEqual(['p:Der Text des Tages.'])
  })

  it('stays with the frame when a title is typed, and goes with a title on an empty page', async () => {
    await show()
    type(box.querySelector<HTMLTextAreaElement>('textarea[aria-label="Überschrift"]')!, 'Ein Tag')
    expect(row()).not.toBeNull()
    await choose(picker()!, '')
    expect(row()).toBeNull()
  })

  it('is not there for a saved page with only a title, and the default frames its empty text', async () => {
    day = page({ title: 'Nur ein Titel', text: '', revision: 1 })
    await show()
    expect(row()).not.toBeNull()
    await eventually(() => expect(blocks()).toHaveLength(6), 'the frame')
  })
})

describe('a frame is no writing', () => {
  it('makes no draft, marks nothing, and cannot be saved', async () => {
    await show()
    await eventually(() => expect(blocks()).toHaveLength(6), 'the frame')
    // Leaving the page sends what is pending as a draft: there is nothing pending.
    await idle()
    await reopen()
    expect(drafts()).toEqual([])
    expect(blocks()).toHaveLength(6)
    expect(saveButtons().every((item) => item.disabled)).toBe(true)
    expect(box.textContent).not.toContain('Entwurf gesichert')
  })

  it('makes no draft either when the tab is hidden: what the editor reads out of the frame is the frame', async () => {
    await show()
    await eventually(() => expect(blocks()).toHaveLength(6), 'the frame')
    // Hidden (a tab away, a phone locked) sends what is pending as a draft; the editor writes its empty lines as extra
    // line breaks, which must not count as something written.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await idle()
    expect(drafts()).toEqual([])
    // The same event after something was typed does send it: the check above has teeth.
    await typeInLine(1, 'Schön war der Abend.')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await idle()
    expect(drafts()).toHaveLength(1)
    expect(drafts()[0].body!.text).toContain('Schön war der Abend.')
    expect(drafts()[0].body!.text).not.toContain('Was war schön?')
  })

  it('can be saved as soon as one section has something in it, and only that section is sent', async () => {
    await show()
    await typeInLine(1, 'Schön war der Abend.')
    await until(() => !saveButtons()[0].disabled, 'Save being possible')
    await act(async () => saveButtons()[0].click())
    await eventually(() => expect(puts()).toHaveLength(1), 'the save')
    expect(puts()[0].body).toMatchObject({ text: '## Schönes\n\nSchön war der Abend.', base_revision: -1 })
    expect(puts()[0].body!.text).not.toContain('Was war schön?')
  })

  it('saves what is typed into several sections, in the order of the template, with the empty ones gone', async () => {
    await show()
    await typeInLine(0, 'Mit Mia Kastanien gesammelt.')
    await typeInLine(2, 'Für das Wetter.')
    await until(() => !saveButtons()[0].disabled, 'Save being possible')
    await act(async () => saveButtons()[0].click())
    await eventually(() => expect(puts()).toHaveLength(1), 'the save')
    expect(puts()[0].body!.text).toBe('## Heute\n\nMit Mia Kastanien gesammelt.\n\n## Dankbar\n\nFür das Wetter.')
  })

  it('keeps every other heading, also an empty one, when it saves', async () => {
    // A draft written under the template, with a heading of the person\'s own and an empty section of the template.
    draft = { title: '', text: '## Heute\n\nEtwas.\n\n## Eigenes\n\n## Schönes\n\n## Dankbar\n\nJa.', tags: [], cover: null, base_revision: -1, written_by: 'self', updated_at: '2026-10-06T17:30:00+00:00' }
    await show()
    expect(row()).toBeNull()
    await until(() => !saveButtons()[0].disabled, 'Save being possible')
    await act(async () => saveButtons()[0].click())
    await eventually(() => expect(puts()).toHaveLength(1), 'the save')
    expect(puts()[0].body!.text).toBe('## Heute\n\nEtwas.\n\n## Eigenes\n\n## Dankbar\n\nJa.')
  })

  it('saves a page without a template exactly as typed, with no section dropped', async () => {
    await show()
    await choose(picker()!, '')
    await typeInLine(0, 'Nur ein Satz.')
    await until(() => !saveButtons()[0].disabled, 'Save being possible')
    await act(async () => saveButtons()[0].click())
    await eventually(() => expect(puts()).toHaveLength(1), 'the save')
    expect(puts()[0].body!.text).toBe('Nur ein Satz.')
  })
})

describe('the AI under a template', () => {
  const NOTES = [{ id: 'n1', text: 'kastanien mit mia', created_at: '2026-10-06T16:00:00+00:00', prompt: null, prompt_id: null, photo_id: null, unreadable: false }]

  it('asks for the template that is chosen, "none" for none, and nothing for a person without templates', async () => {
    dayNotes = NOTES
    await show()
    await act(async () => button('Ausformulieren').click())
    await until(() => asked().length === 1, 'the first request')
    await idle()
    expect(asked()[0].body).toMatchObject({ date: DATE, template: REVIEW.id })
    set = { ...set, default: null }
    await reopen()
    await choose(picker()!, WORK.id)
    await act(async () => button('Ausformulieren').click())
    await until(() => asked().length === 2, 'the second request')
    await idle()
    expect(asked()[1].body!.template).toBe(WORK.id)
    await reopen()
    await choose(picker()!, '')
    await act(async () => button('Ausformulieren').click())
    await until(() => asked().length === 3, 'the third request')
    await idle()
    expect(asked()[2].body!.template).toBe('none')
    set = { templates: [], default: null, revision: -1 }
    await reopen()
    await act(async () => button('Ausformulieren').click())
    await until(() => asked().length === 4, 'the fourth request')
    await idle()
    expect('template' in asked()[3].body!).toBe(false)
  })

  it('puts the suggestion under the headings, and an empty section falls away when the page is saved', async () => {
    dayNotes = NOTES
    await show()
    await act(async () => button('Ausformulieren').click())
    await eventually(() => expect(blocks()).toEqual(['h2:Heute', 'p:Mit Mia Kastanien gesammelt.', 'h2:Schönes', 'p:', 'h2:Dankbar', 'p:']), 'the suggestion')
    expect(box.querySelector<HTMLTextAreaElement>('textarea[aria-label="Überschrift"]')!.value).toBe('Kastanien')
    await until(() => !saveButtons()[0].disabled, 'Save being possible')
    await act(async () => saveButtons()[0].click())
    await eventually(() => expect(puts()).toHaveLength(1), 'the save')
    expect(puts()[0].body).toMatchObject({ title: 'Kastanien', text: '## Heute\n\nMit Mia Kastanien gesammelt.', written_by: 'ai' })
  })

  it('carries the template on when it is asked for "Länger"', async () => {
    dayNotes = NOTES
    await show()
    await act(async () => button('Ausformulieren').click())
    await until(() => box.textContent?.includes('Kürzer') || box.textContent?.includes('Länger'), 'the suggestion')
    await idle()
    await act(async () => [...box.querySelectorAll<HTMLButtonElement>('button')].find((item) => /Kürzer|Länger/.test(item.textContent ?? ''))!.click())
    await until(() => asked().length === 2, 'the second request')
    expect(asked().map((call) => call.body!.template)).toEqual([REVIEW.id, REVIEW.id])
  })

  it('does not ask whether to write over the page when only the frame stands, for the press on "Heute"', async () => {
    dayNotes = NOTES
    await show({ formulate: 'long' })
    await until(() => asked().length === 1, 'the request from "Heute"')
    expect(asked()[0].body).toMatchObject({ length: 'long', template: REVIEW.id })
    expect(box.textContent).not.toContain('Vorhandene Fassung')
    expect(document.body.querySelector('[role=dialog]')).toBeNull()
  })
})

describe('marks of Markdown in headings, a change of template while typing, a template that is only partly there', () => {
  const MARKS = ['C#', 'Plan [A]', 'Dank_ und _mehr', 'a * b', 'Was *wichtig* war', 'Tag & <b>']
  const MARKED: Template = { id: 'cccccccccccc', name: 'Zeichen', sections: MARKS.map((heading) => ({ heading, question: `Frage zu ${heading}` })) }

  it('shows them as typed, cannot save the frame alone, and saves only the section with writing', async () => {
    set = { templates: [MARKED, REVIEW], default: MARKED.id, revision: 1 }
    await show()
    await eventually(() => expect(blocks()).toEqual(MARKS.flatMap((heading) => [`h2:${heading}`, 'p:'])), 'the frame')
    expect(editable().querySelectorAll('p.diary-hint')).toHaveLength(MARKS.length)
    expect(saveButtons().every((item) => item.disabled)).toBe(true)
    await typeInLine(4, 'Das war wichtig.')
    await until(() => !saveButtons()[0].disabled, 'Save being possible')
    await act(async () => saveButtons()[0].click())
    await eventually(() => expect(puts()).toHaveLength(1), 'the save')
    const text = String(puts()[0].body!.text)
    // The stars are the person's own words, so the editor writes them with a backslash.
    expect(text).toBe('## Was \\*wichtig\\* war\n\nDas war wichtig.')
  })

  it('drops the empty ones when the page is opened anew from a draft, and keeps every other', async () => {
    set = { templates: [MARKED, REVIEW], default: REVIEW.id, revision: 1 }
    const bs = String.fromCharCode(92)
    const written = ['C' + bs + '#', 'Plan ' + bs + '[A]', 'Dank' + bs + '_ und ' + bs + '_mehr', 'a ' + bs + '* b', 'Was *wichtig* war', 'Tag & ' + bs + '<b>']
    draft = { title: '', text: written.map((line, at) => (at === 2 ? `## ${line}\n\nGeschrieben.` : `## ${line}`)).join('\n\n\n\n') + '\n\n## Eigenes', tags: [], cover: null, base_revision: -1, written_by: 'self', updated_at: '2026-10-06T17:30:00+00:00' }
    await show()
    expect(row()).toBeNull()
    await eventually(() => expect(editable().querySelectorAll('p.diary-hint').length).toBeGreaterThan(0), 'the hints of the recognised template')
    await until(() => !saveButtons()[0].disabled, 'Save being possible')
    await act(async () => saveButtons()[0].click())
    await eventually(() => expect(puts()).toHaveLength(1), 'the save')
    expect(puts()[0].body!.text).toBe(`## Dank${bs}_ und ${bs}_mehr\n\nGeschrieben.\n\n## Eigenes`)
  })

  it('keeps what was typed when the template is changed before the editor has reported it', async () => {
    await show()
    await typeInLine(0, 'Gerade getippt')
    // At once, within the pause after which the page learns of the typing.
    await choose(picker()!, WORK.id)
    expect(editable().textContent).toContain('Gerade getippt')
    expect(blocks()[0]).toBe('h2:Heute')
    await eventually(() => expect(row()).toBeNull(), 'the line going')
    expect(editable().textContent).not.toContain('Gearbeitet')
    await until(() => !saveButtons()[0].disabled, 'Save being possible')
    await act(async () => saveButtons()[0].click())
    await eventually(() => expect(puts()).toHaveLength(1), 'the save')
    expect(puts()[0].body!.text).toBe('## Heute\n\nGerade getippt')
  })

  it('treats a template as the one chosen when only some of its headings are left, and drops its empty sections', async () => {
    // The person took the heading "Dankbar" away and wrote under "Schönes".
    draft = { title: '', text: '## Heute\n\n## Eigenes\n\nMein Satz.\n\n## Schönes\n\nSchön.', tags: [], cover: null, base_revision: -1, written_by: 'self', updated_at: '2026-10-06T17:30:00+00:00' }
    await show()
    await until(() => !saveButtons()[0].disabled, 'Save being possible')
    await act(async () => saveButtons()[0].click())
    await eventually(() => expect(puts()).toHaveLength(1), 'the save')
    expect(puts()[0].body!.text).toBe('## Eigenes\n\nMein Satz.\n\n## Schönes\n\nSchön.')
  })
})
