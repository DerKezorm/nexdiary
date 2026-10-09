/**
 * The cards for the AI and the writing prompts, against a server stand-in: the operator chooses a kind of service,
 * types what it needs (the Messages API brings its own address, a local model a key only if its service wants one)
 * and tries it; a person switches groups of questions and own questions one at a time (never a whole list that could
 * put back what another tab changed), and the AI for themselves (Account, AI).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import type { Me } from '../../api/client'
import '../../i18n'
import { changeLanguage } from '../../i18n'
import { LOCAL_URL, MESSAGES_URL, PROVIDER_NAME } from '../../lib/aiProviders'
import { AccountPage } from '../AccountPage'
import { AiCard } from './AiCard'
import { PromptsCard } from './PromptsCard'
import { idle } from '../../test/wait'

const me = {
  id: 1, name: 'jule', display_name: 'Jule', role: 'operator', sign_in: 'password', email: '', language: 'de', oidc_linked: false, two_factor: true,
  totp: true, passkeys: 0, two_factor_recovery_left: 8, avatar: null, version: '0.1.0', whats_new_seen: '',
  profile: { mode: 'system', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true },
} as Me
const setMe = vi.fn()
vi.mock('../../state/auth', () => ({ useAuth: () => ({ me, setMe }) }))

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let settings: Record<string, unknown>
let choice: { on: boolean; sets: { id: string; name: string; questions: string[]; on: boolean }[]; own: { id: string; text: string }[] }

const SETS = [
  ['schoen', 'Schöne Momente', true], ['gefuehle', 'Gefühle', true], ['wuensche', 'Wünsche und Ziele', true], ['dank', 'Dankbarkeit', true],
  ['menschen', 'Familie und Freunde', false], ['rueckblick', 'Rückblick am Sonntag', false],
] as const

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/settings/ai' && method === 'PUT') {
        settings = { ...settings, ...body, key_set: Boolean(body!.key) || Boolean(settings.key_set) }
        delete settings.key
        return json(settings)
      }
      if (url === '/api/settings/ai') return json(settings)
      if (url === '/api/settings/ai/probe') return json({ seconds: 2.1 })
      if (url === '/api/settings/ai/models') return json([{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: '' }])
      if (url === '/api/ai') return json({ provider: 'local', to: '', model: 'llama3.1:8b', mine: true, available: true })
      if (url === '/api/prompts' && method === 'PUT') {
        choice = { ...choice, on: body!.on as boolean }
        return json(choice)
      }
      if (url.startsWith('/api/prompts/sets/')) {
        const id = url.split('/').at(-1)
        choice = { ...choice, sets: choice.sets.map((entry) => (entry.id === id ? { ...entry, on: body!.on as boolean } : entry)) }
        return json(choice)
      }
      if (url === '/api/prompts/own') {
        // Another tab added one meanwhile: the server's answer brings it along.
        choice = { ...choice, own: [...choice.own, { id: 'own.aaaaaaaaaaaa', text: 'Aus dem anderen Tab?' }, { id: 'own.bbbbbbbbbbbb', text: body!.text as string }] }
        return json(choice, 201)
      }
      if (url.startsWith('/api/prompts/own/')) {
        const id = url.split('/').at(-1)
        choice = { ...choice, own: choice.own.filter((entry) => entry.id !== id) }
        return json(choice)
      }
      if (url === '/api/prompts') return json(choice)
      if (url === '/api/me/preferences') return json({ ...me.profile, ...body })
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function show(element: React.ReactNode, at = '/'): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => root.render(<MemoryRouter initialEntries={[at]}>{element}</MemoryRouter>))
  await idle()
}

function button(text: string): HTMLButtonElement | undefined {
  return [...box.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim().startsWith(text) || item.getAttribute('aria-label') === text)
}

function field(label: string): HTMLInputElement | undefined {
  return [...box.querySelectorAll('label')].find((item) => item.textContent?.startsWith(label))?.querySelector('input') ?? undefined
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(target: HTMLElement | undefined): Promise<void> {
  expect(target).toBeTruthy()
  await act(async () => target!.click())
  await idle()
}

beforeEach(async () => {
  await changeLanguage('de', false)
  settings = { provider: 'none', url: '', model: '', key_set: false }
  choice = { on: true, sets: SETS.map(([id, name, on]) => ({ id, name, questions: [`${name} 1?`, `${name} 2?`, `${name} 3?`], on })), own: [] }
  setMe.mockClear()
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

const saves = () => calls.filter((call) => call.method === 'PUT' && call.url === '/api/settings/ai').map((call) => call.body)

describe('the AI under Server', () => {
  it('starts with none and sets up a local model with its address, without a key, and tries it', async () => {
    await show(<AiCard />)
    expect(button('Keine KI')!.getAttribute('aria-pressed')).toBe('true')
    await click(button('Lokales Modell'))
    expect(field('Adresse')!.value).toBe(LOCAL_URL)
    // Optional for a local model: only where its service asks for one.
    expect(field('API-Schlüssel (falls nötig)')!.value).toBe('')
    expect(box.textContent).not.toContain('Was hinausgeht')
    type(field('Modell')!, 'llama3.1:8b')
    await click(button('Speichern und ausprobieren'))
    expect(saves()).toEqual([{ provider: 'local', url: LOCAL_URL, model: 'llama3.1:8b' }])
    expect(calls.filter((call) => call.url === '/api/settings/ai/probe')).toHaveLength(1)
    expect(box.textContent).toContain('Gespeichert. Probe: Das Modell hat in 2,1 Sekunden geantwortet.')
  })

  it('fills in the address of the Messages API, takes a key and never shows it', async () => {
    await show(<AiCard />)
    await click(button(PROVIDER_NAME.messages!))
    expect(field('Adresse')).toBeUndefined()
    expect(box.textContent).toContain('Was hinausgeht: beim Druck auf „Ausformulieren mit KI“ die Notizen dieses einen Tages')
    const key = `k-${Math.random().toString(36).slice(2)}`
    type(field('API-Schlüssel')!, key)
    await click(button('Modelle abrufen'))
    expect(calls.find((call) => call.url === '/api/settings/ai/models')!.body).toEqual({ provider: 'messages', url: MESSAGES_URL, key })
    expect(box.querySelector('select')).not.toBeNull()
    await act(async () => {
      const select = box.querySelector('select')!
      select.value = 'model-b'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click(button('Speichern und ausprobieren'))
    expect(saves()).toEqual([{ provider: 'messages', url: MESSAGES_URL, model: 'model-b', key }])
    expect(field('API-Schlüssel')!.value).toBe('')
    expect(field('API-Schlüssel')!.placeholder).toBe('gespeichert, leer lassen zum Behalten')
  })

  it('switches the AI off at once with "Keine KI"', async () => {
    settings = { provider: 'local', url: LOCAL_URL, model: 'llama3.1:8b', key_set: false }
    await show(<AiCard />)
    await click(button('Keine KI'))
    expect(saves()).toEqual([{ provider: 'none' }])
    expect(box.textContent).toContain('Gespeichert.')
  })
})

describe('the writing prompts under General', () => {
  it('switches groups, adds and removes own questions, and switches questions off', async () => {
    await show(<PromptsCard />)
    expect(box.textContent).toContain('„Schöne Momente 1?“ und 2 weitere')
    await click(button('Familie und Freunde'))
    expect([calls.at(-1)!.method, calls.at(-1)!.url, calls.at(-1)!.body]).toEqual(['PUT', '/api/prompts/sets/menschen', { on: true }])
    type(field('Neue Frage')!, 'Was hat Mia heute gesagt?')
    await act(async () => box.querySelector('form')!.requestSubmit())
    await idle()
    expect([calls.at(-1)!.method, calls.at(-1)!.url, calls.at(-1)!.body]).toEqual(['POST', '/api/prompts/own', { text: 'Was hat Mia heute gesagt?' }])
    // What the server holds now, the question of the other tab included.
    expect(box.textContent).toContain('Was hat Mia heute gesagt?')
    expect(box.textContent).toContain('Aus dem anderen Tab?')
    await click(button('Frage entfernen: Was hat Mia heute gesagt?'))
    expect([calls.at(-1)!.method, calls.at(-1)!.url]).toEqual(['DELETE', '/api/prompts/own/own.bbbbbbbbbbbb'])
    expect(box.textContent).toContain('Aus dem anderen Tab?')
    expect(calls.filter((call) => call.body && ('own' in call.body || 'sets' in call.body))).toEqual([])
    await click(box.querySelector<HTMLButtonElement>('[role=switch]')!)
    expect(calls.at(-1)!.body).toEqual({ on: false })
    expect(box.textContent).not.toContain('Welche Fragen')
  })
})

describe('the AI under My account', () => {
  it('switches the AI off for oneself and says what the operator set up', async () => {
    await show(<AccountPage />, '/konto?tab=ai')
    expect(box.textContent).toContain('Vom Betreiber eingestellt: Lokales Modell (llama3.1:8b)')
    expect(box.textContent).toContain('Ollama oder ein anderer Dienst im eigenen Netz. Nichts verlässt das Haus.')
    await click(box.querySelector<HTMLButtonElement>('[role=switch]')!)
    expect(calls.filter((call) => call.url === '/api/me/preferences').map((call) => call.body)).toEqual([{ ai: false }])
    expect(setMe).toHaveBeenCalledWith(expect.objectContaining({ profile: expect.objectContaining({ ai: false }) }))
  })
})
