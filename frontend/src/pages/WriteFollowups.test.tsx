/**
 * "Erst fragen lassen" on the writing page of a day (a past one too), where "Ausformulieren" stands: the questions of
 * the AI, the answers as notes of that day with their question, then the AI writes from all notes. And the switch for
 * the family question under My account, Writing.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import '../i18n'
import { changeLanguage } from '../i18n'
import { Markdown } from '../components/Markdown'
import { FamilyCard } from './settings/PersonalCards'
import WritePage from './WritePage'
import { eventually, idle, until } from '../test/wait'

const me = { name: 'jule', display_name: 'Jule', profile: { mode: 'light', layout: 'page', quick_start: false, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'manual', family: false } }
const setMe = vi.fn()
vi.mock('../state/auth', () => ({ useAuth: () => ({ me, setMe }) }))

const DATE = '2026-10-01'
const NOTE = { id: 'n1', date: DATE, text: 'lena fand die idee mit dem board gut', unreadable: false, prompt: null, prompt_id: null, photo_id: null, created_at: '2026-10-01T07:40:00+00:00', updated_at: null }

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let notes: Record<string, unknown>[] = []
/** The page of the day; null: none yet. */
let page: Record<string, unknown> | null = null

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === `/api/days/${DATE}/draft`) return json(null)
      if (url === `/api/days/${DATE}`) return page ? json(page) : json({ detail: { code: 'not_found', message: 'x' } }, 404)
      if (url === '/api/ai') return json({ provider: 'local', to: '', model: 'm', mine: true, available: true })
      if (url === '/api/ai/followups') return json({ questions: [{ question: 'Was war die Idee?', note_id: 'n1', at: NOTE.created_at }] })
      if (url === '/api/ai/formulate') return json({ title: 'Das Board', text: 'Lena fand die Idee gut.', length: body!.length })
      if (url === '/api/notes' && method === 'POST') {
        const note = { ...NOTE, id: body!.id, text: body!.text, prompt: body!.prompt, created_at: '2026-10-07T18:00:00+00:00' }
        notes = [...notes, note]
        return json(note, 201)
      }
      if (url.startsWith('/api/notes')) return json(notes)
      if (url === '/api/me/preferences') return json({ ...me.profile, ...body })
      if (url.startsWith('/api/prompts/pool')) return json({ questions: [] })
      if (url.startsWith('/api/templates')) return json({ templates: [], default: null, revision: 0 })
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function render(element: React.ReactElement, path = '/'): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={element} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await idle()
}

function button(text: string, inside: ParentNode = box): HTMLButtonElement | undefined {
  return [...inside.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text)
}

beforeEach(async () => {
  await changeLanguage('de', false)
  page = null
  notes = [NOTE]
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('the writing page of a past day', () => {
  it('lets the AI ask first, keeps the answer as a note of that day and writes from all notes', async () => {
    box = document.createElement('div')
    document.body.appendChild(box)
    root = createRoot(box)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[`/tag/${DATE}/schreiben`]}>
          <Routes>
            <Route path="/tag/:date/schreiben" element={<WritePage />} />
          </Routes>
        </MemoryRouter>,
      ),
    )
    await until(() => box.querySelector('[data-offer-ai]'), 'the offer of the AI')
    const offer = box.querySelector('[data-offer-ai]')!
    // Under "Ausformulieren", before the sentence that says where the notes go.
    const ask = button('Erst fragen lassen', offer)!
    expect(ask.compareDocumentPosition(offer.querySelector('p')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await act(async () => ask.click())
    const dialog = () => document.querySelector<HTMLElement>('[role=dialog]')!
    await eventually(() => expect(dialog().textContent).toContain('Was war die Idee?'), 'the question')
    expect(dialog().textContent).toContain('zur Notiz von 09:40 Uhr')
    const field = dialog().querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(field, 'Ein Board für die Woche.')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Ausformulieren', dialog())!.click())
    await idle()
    const kept = calls.filter((call) => call.url === '/api/notes' && call.method === 'POST')
    expect(kept.map((call) => [call.body!.date, call.body!.text, call.body!.prompt])).toEqual([[DATE, 'Ein Board für die Woche.', 'Was war die Idee?']])
    await eventually(() => expect(calls.filter((call) => call.url === '/api/ai/formulate').map((call) => call.body!.date)).toEqual([DATE]), 'the page written')
    // The answer stands beside the page with its question.
    expect(box.textContent).toContain('Ein Board für die Woche.')
    expect(box.querySelector<HTMLTextAreaElement>('textarea[aria-label="Überschrift"]')!.value).toBe('Das Board')
  })
})

async function showWriting(): Promise<void> {
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[`/tag/${DATE}/schreiben`]}>
        <Routes>
          <Route path="/tag/:date/schreiben" element={<WritePage />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await until(() => box.querySelector('[contenteditable]'), 'the editor')
  await idle()
}

const WRITTEN = { date: DATE, title: 'Tom & Jerry', text: 'Tom \\& Jerry \\&amp; Co.', tags: [], values: {}, cover: 'illu:baum.abend.herbst', cover_chosen: true, written_by: 'self', words: 4, revision: 3, created_at: '', updated_at: '2026-10-01T20:00:00+00:00' }

describe('a day that has a page already', () => {
  it('lets the AI ask first from the bar too, and asks before it writes over the page', async () => {
    page = WRITTEN
    await showWriting()
    const ask = box.querySelector<HTMLButtonElement>('[data-write-bar] button[aria-label="Erst fragen lassen"]')!
    await act(async () => ask.click())
    const dialog = () => document.querySelector<HTMLElement>('[role=dialog]')!
    await eventually(() => expect(dialog().textContent).toContain('Was war die Idee?'), 'the question')
    await act(async () => button('Ohne Antworten weiter', dialog())!.click())
    await idle()
    expect(dialog().textContent).toContain('Seite neu ausformulieren?')
    expect(calls.some((call) => call.url === '/api/ai/formulate')).toBe(false)
  })

  it('shows an escaped & of a short entry as written, in the reader and in the editor', async () => {
    page = WRITTEN
    await showWriting()
    expect(box.querySelector('[contenteditable]')!.textContent).toBe('Tom & Jerry &amp; Co.')
    act(() => root.unmount())
    box.remove()
    await render(<Markdown text={String(WRITTEN.text)} />)
    expect(box.textContent).toBe('Tom & Jerry &amp; Co.')
  })
})

describe('the family question under My account', () => {
  it('is off from the start, says what taking part means and what leaving does', async () => {
    await render(<FamilyCard />)
    expect(box.textContent).toContain('Bei der Familienfrage mitmachen')
    expect(box.textContent).toContain('Jeden Tag eine Frage für alle, die mitmachen. Die Antworten der anderen siehst du, sobald du selbst geantwortet hast.')
    expect(box.textContent).toContain('Machst du nicht mehr mit, sieht niemand mehr deine Antworten.')
    const toggle = box.querySelector<HTMLElement>('[role=switch], input[type=checkbox]')!
    expect(toggle.getAttribute('aria-checked') ?? String((toggle as HTMLInputElement).checked)).toBe('false')
    await act(async () => toggle.click())
    await idle()
    expect(calls.filter((call) => call.url === '/api/me/preferences').map((call) => call.body)).toEqual([{ family: true }])
  })
})
