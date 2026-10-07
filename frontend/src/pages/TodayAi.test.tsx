/**
 * "Today" and the quick note with the AI and the writing prompts, against a server stand-in: "Ausformulieren" appears
 * only when there is an AI for this person and notes to write from, says before the press where the notes go, and
 * leads to the writing page with the length chosen (never a request of its own); the question of the day is answered
 * as a note with its question, and "Andere Frage" asks the server for the next.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import type { Profile } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { MESSAGES_URL, PROVIDER_NAME } from '../lib/aiProviders'
import { QuickPage } from './QuickPage'
import { TodayPage } from './TodayPage'

const me: { name: string; display_name: string; profile: Profile } = {
  name: 'jule',
  display_name: 'Jule',
  profile: { mode: 'system', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true },
}
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))

const NOTE = { id: 'a0000000-0000-4000-8000-000000000001', date: '2026-10-06', text: 'kastanien gesammelt', unreadable: false, prompt: null, photo_id: null, created_at: '2026-10-06T16:50:00+00:00', updated_at: null }
const QUESTION = 'Was hat dich heute glücklich gemacht?'
const NEXT = 'Worüber hast du heute gelacht?'
const ASKED = { id: 'schoen.0', text: QUESTION }
const COMING = { id: 'schoen.1', text: NEXT }

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let today: Record<string, unknown>
let ai: Record<string, unknown>

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.startsWith('/api/today')) return json(today)
      if (url === '/api/ai') return json(ai)
      if (url === '/api/prompts/another') {
        today = { ...today, question: COMING }
        return json({ question: COMING })
      }
      if (url === '/api/notes' && method === 'POST') {
        const note = { ...NOTE, id: body!.id, text: body!.text, prompt: body!.prompt ?? null }
        today = { ...today, notes: [...(today.notes as unknown[]), note], question: COMING }
        return json(note, 201)
      }
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

/** Where "Ausformulieren" leads: the writing page, showing what it was handed. */
function Writing() {
  const location = useLocation()
  return <p data-writing>{JSON.stringify(location.state)}</p>
}

async function show(page: 'today' | 'quick' = 'today'): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={page === 'today' ? <TodayPage now={new Date(2026, 9, 6, 19, 30)} /> : <QuickPage />} />
          <Route path="/tag/:date/schreiben" element={<Writing />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
}

function button(text: string): HTMLButtonElement | undefined {
  return [...box.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)
}

function type(field: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  await changeLanguage('de', false)
  // jsdom lays nothing out: the quick note scrolls its list to the newest note.
  Element.prototype.scrollTo = vi.fn()
  today = { date: '2026-10-06', notes: [NOTE], day: null, values: [], streak: 4, photos: [], question: ASKED }
  ai = { provider: 'local', to: '', model: 'llama3.1:8b', mine: true, available: true }
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('writing the day up with the AI', () => {
  it('says that a local model keeps the notes at home, and asks nothing before the press', async () => {
    await show()
    expect(button('Ausformulieren')).toBeTruthy()
    expect(box.textContent).toContain('Wird mit dem lokalen Modell eures Servers formuliert. Nichts verlässt das Haus.')
    expect(box.textContent).toContain('Die KI ordnet und glättet nur, sie erfindet nichts dazu.')
    expect(calls.some((call) => call.url.startsWith('/api/ai/'))).toBe(false)
  })

  it('names where the notes go for a service on the internet', async () => {
    ai = { provider: 'messages', to: new URL(MESSAGES_URL).hostname, model: 'm', mine: true, available: true }
    await show()
    expect(box.textContent).toContain(`Deine Notizen gehen dabei an ${PROVIDER_NAME.messages}.`)
    act(() => root.unmount())
    box.remove()
    // The Messages API at another address: that host is named, not the provider.
    ai = { provider: 'messages', to: 'proxy.example.com', model: 'm', mine: true, available: true }
    await show()
    expect(box.textContent).toContain('Deine Notizen gehen dabei an proxy.example.com.')
    act(() => root.unmount())
    box.remove()
    ai = { provider: 'openai', to: 'ai.example.com', model: 'm', mine: true, available: true }
    await show()
    expect(box.textContent).toContain('Deine Notizen gehen dabei an ai.example.com.')
  })

  it('leads to the writing page with the length chosen', async () => {
    await show()
    await act(async () => [...box.querySelectorAll<HTMLButtonElement>('[role=radio]')].find((item) => item.textContent === 'kurz')!.click())
    await act(async () => button('Ausformulieren')!.click())
    expect(box.querySelector('[data-writing]')!.textContent).toBe('{"formulate":"short"}')
    expect(calls.some((call) => call.url.startsWith('/api/ai/'))).toBe(false)
  })

  it('is not offered when the AI is off for the person, there is none, there are no notes, or a page stands', async () => {
    for (const [state, day] of [
      [{ provider: 'local', to: '', model: '', mine: false, available: false }, null],
      [{ provider: 'none', to: '', model: '', mine: true, available: false }, null],
      [{ provider: 'local', to: '', model: '', mine: true, available: true }, { text: 'Schon geschrieben.', title: '', tags: [], values: {} }],
    ] as const) {
      ai = state
      today = { ...today, day }
      await show()
      expect(button('Ausformulieren')).toBeUndefined()
      expect(box.textContent).toMatch(/Selbst schreiben|Weiterschreiben/)
      act(() => root.unmount())
      box.remove()
    }
    today = { ...today, day: null, notes: [] }
    await show()
    expect(button('Ausformulieren')).toBeUndefined()
  })
})

describe('the question of the day', () => {
  it('is answered as a note with its question, and the next one comes', async () => {
    await show()
    expect(box.querySelector('[data-question]')!.textContent).toBe(QUESTION)
    await act(async () => button('Antworten')!.click())
    type(box.querySelector<HTMLTextAreaElement>('textarea[aria-label="Deine Antwort auf die Frage des Tages"]')!, 'mit mia im park')
    const card = box.querySelector('section[aria-label="Frage des Tages"]')!
    await act(async () => [...card.querySelectorAll('button')].find((item) => item.textContent === 'Notieren')!.click())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
    const sent = calls.filter((call) => call.url === '/api/notes' && call.method === 'POST')
    expect(sent.map((call) => [call.body!.text, call.body!.prompt, call.body!.prompt_id])).toEqual([['mit mia im park', QUESTION, 'schoen.0']])
    expect(box.querySelector('[data-question]')!.textContent).toBe(NEXT)
  })

  it('moves on with "Andere Frage"', async () => {
    await show()
    await act(async () => button('Andere Frage')!.click())
    expect(calls.filter((call) => call.url === '/api/prompts/another').map((call) => call.method)).toEqual(['POST'])
    expect(box.querySelector('[data-question]')!.textContent).toBe(NEXT)
  })

  it('is not there when the person switched questions off', async () => {
    today = { ...today, question: null }
    await show()
    expect(button('Antworten')).toBeUndefined()
  })

  it('stands in the quick note too: tapped, the next note answers it', async () => {
    await show('quick')
    const chip = button(`Auf die Frage antworten: ${QUESTION}`)!
    expect(chip.textContent).toBe(QUESTION)
    await act(async () => chip.click())
    const field = box.querySelector<HTMLTextAreaElement>('textarea')!
    expect(field.placeholder).toBe('Deine Antwort …')
    type(field, 'kastanien')
    await act(async () => button('Notieren')!.click())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
    const sent = calls.filter((call) => call.url === '/api/notes' && call.method === 'POST')
    expect(sent.map((call) => [call.body!.prompt, call.body!.prompt_id])).toEqual([[QUESTION, 'schoen.0']])
    expect(box.querySelector<HTMLTextAreaElement>('textarea')!.placeholder).toBe('Kurz notieren …')
    // Put away for this visit.
    await act(async () => button('Frage ausblenden')!.click())
    expect(box.textContent).not.toContain(NEXT)
    expect(box.textContent).toContain('In Ruhe, mit Werten, Fotos und auf Wunsch der KI')
  })
})

describe('text shared into the quick note', () => {
  it('lands in the field once and leaves the address, so a reload does not bring it back', async () => {
    const { BrowserRouter } = await import('react-router-dom')
    window.history.replaceState(null, '', '/?text=Kastanien%20im%20Park')
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    box = document.createElement('div')
    document.body.appendChild(box)
    root = createRoot(box)
    await act(async () =>
      root.render(
        <BrowserRouter>
          <QuickPage />
        </BrowserRouter>,
      ),
    )
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    expect(box.querySelector('textarea')!.value).toBe('Kastanien im Park')
    expect(window.location.search).toBe('')
    window.history.replaceState(null, '', '/')
  })
})
