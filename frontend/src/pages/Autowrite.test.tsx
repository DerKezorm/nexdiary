/**
 * Writing up the day before on its own: the person's switch (off from the start, asked and told where the notes go
 * before it is turned on, the server told it was confirmed), its time and length, where it shows at all (only where the
 * operator opened it, the AI is on for the person and for the account); the operator's second bolt; and the cards that
 * lead to a draft that waits.
 */
import { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import type { Me } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { AutoDraftCard, CatchUpCard } from '../components/CatchUp'
import { AccountPage, AutoWrite } from './AccountPage'
import { AiCard } from './settings/AiCard'
import { idle } from '../test/wait'

const auth = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  me: null as unknown as Me,
}))

vi.mock('../state/auth', () => ({
  useAuth: () => {
    const me = useSyncExternalStore(
      (listener) => {
        auth.listeners.add(listener)
        return () => auth.listeners.delete(listener)
      },
      () => auth.me,
    )
    return {
      me,
      setMe: (next: Me) => {
        auth.me = next
        auth.listeners.forEach((listener) => listener())
      },
    }
  },
}))

const baseMe = (profile: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({
    id: 1, name: 'jule', display_name: 'Jule', role: 'member', sign_in: 'password', email: '', language: 'de', oidc_linked: false, two_factor: true,
    totp: true, passkeys: 0, two_factor_recovery_left: 8, avatar: null, version: '0.1.0', whats_new_seen: '', ai_allowed: true,
    profile: { mode: 'system', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true, ...profile },
    ...extra,
  }) as unknown as Me

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let ai: Record<string, unknown>
let refuse: string | null = null
let operator: Record<string, unknown>

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/me/autowrite') {
        if (refuse) return json({ detail: { code: refuse, message: 'x' } }, 403)
        const { confirmed: _confirmed, ...kept } = body!
        return json({ ...(auth.me.profile.autowrite ?? { on: false, time: '07:00', length: 'long' }), ...kept })
      }
      if (url === '/api/ai') return json(ai)
      if (url === '/api/settings/ai' && method === 'PUT') {
        operator = { ...operator, ...body }
        return json(operator)
      }
      if (url === '/api/settings/ai') return json(operator)
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function mount(element: React.ReactNode): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => root.render(<MemoryRouter initialEntries={['/konto?tab=ai']}>{element}</MemoryRouter>))
  await idle()
}

function Harness({ to = '', model = 'llama3.1:8b' }: { to?: string; model?: string }) {
  const me = useSyncExternalStore(
    (listener) => {
      auth.listeners.add(listener)
      return () => auth.listeners.delete(listener)
    },
    () => auth.me,
  )
  return <AutoWrite me={me} to={to} model={model} />
}

const named = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)!
const toggle = () => box.querySelector<HTMLButtonElement>('[data-autowrite] button[role=switch]')!
const puts = () => calls.filter((call) => call.url === '/api/me/autowrite')

beforeEach(async () => {
  await changeLanguage('de', false)
  auth.me = baseMe()
  ai = { provider: 'local', to: '', model: 'llama3.1:8b', mine: true, allowed: true, available: true, auto_allowed: true }
  operator = { provider: 'local', url: 'http://ollama.example.com:11434/v1/', model: 'llama3.1:8b', key_set: false, auto_allowed: false }
  refuse = null
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('the switch of the person', () => {
  it('is off from the start, with nothing to choose', async () => {
    await mount(<Harness />)
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(box.querySelector('select')).toBeNull()
    expect(puts()).toHaveLength(0)
  })

  it('asks first and says where the notes go: to the host of a service on the internet', async () => {
    await mount(<Harness to="api.example.com" />)
    await act(async () => toggle().click())
    const dialog = document.querySelector('[role=dialog]')!
    expect(dialog.textContent).toContain('Deine Notizen gehen dann jeden Morgen ohne Knopfdruck an api.example.com.')
    expect(puts()).toHaveLength(0)
    // "Cancel": nothing is sent, it stays off.
    await act(async () => named('Abbrechen').click())
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(puts()).toHaveLength(0)
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })

  it('names the model of the operator for a local service', async () => {
    await mount(<Harness to="" model="llama3.1:8b" />)
    await act(async () => toggle().click())
    expect(document.querySelector('[role=dialog]')!.textContent).toContain('das Modell deines Betreibers (llama3.1:8b)')
  })

  it('tells the server it was confirmed, and then offers the time and the length', async () => {
    await mount(<Harness to="api.example.com" />)
    await act(async () => toggle().click())
    await act(async () => named('Einschalten').click())
    await idle()
    expect(puts().map((call) => call.body)).toEqual([{ on: true, confirmed: true }])
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(auth.me.profile.autowrite).toMatchObject({ on: true })
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(box.querySelector('select')?.value).toBe('07:00')
    expect([...box.querySelectorAll('select option')].map((option) => (option as HTMLOptionElement).value)).toEqual(
      ['04:00', '04:30', '05:00', '05:30', '06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30'],
    )
  })

  it('switches off at once, without asking, and keeps a time chosen', async () => {
    auth.me = baseMe({ autowrite: { on: true, time: '06:30', length: 'short' } })
    await mount(<Harness />)
    expect(box.querySelector('select')?.value).toBe('06:30')
    expect(box.querySelector('[role=radio][aria-checked=true]')?.textContent).toBe('kurz')
    await act(async () => toggle().click())
    await idle()
    expect(puts().map((call) => call.body)).toEqual([{ on: false }])
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })

  it('sends a changed time and a changed length, each on its own', async () => {
    auth.me = baseMe({ autowrite: { on: true, time: '07:00', length: 'long' } })
    await mount(<Harness />)
    const select = box.querySelector('select')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, '08:30')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => [...box.querySelectorAll<HTMLButtonElement>('[role=radio]')].find((item) => item.textContent === 'kurz')!.click())
    await idle()
    expect(puts().map((call) => call.body)).toEqual([{ time: '08:30' }, { length: 'short' }])
  })

  it('shows a time the server holds that the list does not offer', async () => {
    auth.me = baseMe({ autowrite: { on: true, time: '07:15', length: 'long' } })
    await mount(<Harness />)
    expect(box.querySelector('select')?.value).toBe('07:15')
  })

  it('says why when the server refuses, and stays off', async () => {
    refuse = 'ai_auto_off'
    await mount(<Harness to="api.example.com" />)
    await act(async () => toggle().click())
    await act(async () => named('Einschalten').click())
    await idle()
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('Dein Betreiber hat das automatische Ausformulieren nicht erlaubt.')
    expect(auth.me.profile.autowrite).toBeUndefined()
  })
})

describe('where it shows', () => {
  const part = () => box.querySelector('[data-autowrite]')

  it('shows where the operator opened it, the AI works and the person has it on', async () => {
    await mount(<AccountPage />)
    expect(part()).toBeTruthy()
  })

  it.each([
    ['the operator keeps it closed', () => (ai = { ...ai, auto_allowed: false })],
    ['there is no AI at all', () => (ai = { ...ai, provider: 'none', available: false })],
    ['the person switched the AI off', () => (auth.me = baseMe({ ai: false }))],
    ['the operator took the AI from the account', () => (auth.me = baseMe({}, { ai_allowed: false }))],
  ])('does not show where %s', async (_name, change) => {
    change()
    await mount(<AccountPage />)
    expect(part()).toBeNull()
  })
})

describe('the second bolt of the operator', () => {
  it('is off from the start and saved on its own', async () => {
    await mount(<AiCard />)
    const bolt = [...box.querySelectorAll<HTMLButtonElement>('button[role=switch]')].find((item) => item.closest('div')?.textContent?.includes('Automatisches Ausformulieren erlauben'))!
    expect(bolt.getAttribute('aria-checked')).toBe('false')
    await act(async () => bolt.click())
    await idle()
    expect(calls.filter((call) => call.method === 'PUT' && call.url === '/api/settings/ai').map((call) => call.body)).toEqual([{ auto_allowed: true }])
  })

  it('has no place while there is no service', async () => {
    operator = { provider: 'none', url: '', model: '', key_set: false, auto_allowed: false }
    await mount(<AiCard />)
    expect(box.textContent).not.toContain('Automatisches Ausformulieren erlauben')
  })
})

describe('the draft that waits', () => {
  const data = (extra: Record<string, unknown> = {}) => ({ count: 2, auto: 1, days: [{ date: '2026-10-06', notes: 3, start: 'mit mia im park', auto: true }, { date: '2026-10-04', notes: 1, start: 'regen', auto: false }], ...extra })

  it('is a card on "Today" that leads to the writing of that day', async () => {
    await mount(<AutoDraftCard data={data()} today="2026-10-07" />)
    expect(box.textContent).toContain('Dein Entwurf von gestern wartet')
    expect(box.querySelector('a')?.getAttribute('href')).toBe('/tag/2026-10-06/schreiben')
    expect(box.textContent).toContain('Automatisch ausformuliert. Lies ihn durch')
  })

  it('names the day when it is not yesterday, and counts the others', async () => {
    await mount(<AutoDraftCard data={data({ auto: 3 })} today="2026-10-09" />)
    expect(box.textContent).toContain('Dein Entwurf vom Dienstag, 6. Oktober wartet')
    expect(box.textContent).toContain('Und 2 weitere Entwürfe warten.')
  })

  it('is not there without one', async () => {
    await mount(<AutoDraftCard data={data({ auto: 0, days: [{ date: '2026-10-04', notes: 1, start: 'regen', auto: false }] })} today="2026-10-07" />)
    expect(box.textContent).toBe('')
  })

  it('marks the day in the list of days without a page, and leads to it', async () => {
    await mount(<CatchUpCard data={data()} open />)
    const rows = [...box.querySelectorAll('li')]
    expect(rows[0].textContent).toContain('Automatisch ausformuliert, wartet auf dich')
    expect(rows[0].querySelector('a')?.textContent?.trim()).toBe('Ansehen')
    expect(rows[1].textContent).not.toContain('Automatisch')
    expect(rows[1].querySelector('a')?.textContent?.trim()).toBe('Aufschreiben')
  })
})
