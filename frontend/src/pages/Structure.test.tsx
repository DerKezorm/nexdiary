/**
 * Who has what: everything personal is under "My account" (seven tabs), "Settings" is the operator's (one row of ten
 * tabs). A member who types the address is sent to their account, and the addresses of the time before the split still
 * lead to the right place.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import type { Me } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { AccountPage } from './AccountPage'
import { SettingsPage } from './SettingsPage'

const asked = vi.hoisted(() => ({ role: 'operator' as 'operator' | 'member' }))
const me = (): Me =>
  ({
    id: 1, name: 'jule', display_name: 'Jule', role: asked.role, sign_in: 'password', email: 'jule@example.com', language: 'de',
    oidc_linked: false, two_factor: true, totp: true, passkeys: 0, two_factor_recovery_left: 10, avatar: null, version: '0.1.0', whats_new_seen: '0.1.0',
    profile: { palette: 'salbei', mode: 'light', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true },
  }) as Me
vi.mock('../state/auth', () => ({ useAuth: () => ({ me: me(), setMe: () => undefined }) }))

let root: Root
let box: HTMLDivElement

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.pathname + location.search}</output>
}

async function show(entry: string): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Where />
        <Routes>
          <Route path="/konto" element={<AccountPage />} />
          <Route path="/einstellungen" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
}

const where = () => box.querySelector('[data-testid="where"]')!.textContent
const tabs = () => [...box.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())
const selected = () => box.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim()

beforeEach(async () => {
  asked.role = 'operator'
  await changeLanguage('de', false)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => new Response(/accounts|backups|logs|locales/.test(url) ? '[]' : url.includes('readiness') ? '{"points":[],"open":0}' : '{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

describe('My account', () => {
  it('has seven tabs, the same for everybody', async () => {
    for (const role of ['member', 'operator'] as const) {
      asked.role = role
      await show('/konto')
      expect(tabs(), role).toEqual(['Profil', 'Sicherheit', 'Aussehen', 'Schreiben', 'Erinnerungen', 'KI', 'Verbindungen'])
      await act(async () => root.unmount())
      box.remove()
    }
    await show('/konto')
  })

  it('keeps the colours and the layouts under Look and the values and the questions under Writing', async () => {
    await show('/konto?tab=looks')
    expect(selected()).toBe('Aussehen')
    expect(box.textContent).toContain('Themes')
    expect(box.textContent).toContain('Aufbau von „Heute“')
    expect(box.textContent).toContain('Aufbau des Tagebuchs')
    expect(box.textContent).toContain('Auf dem Handy')
    await act(async () => root.unmount())
    box.remove()
    await show('/konto?tab=writing')
    expect(selected()).toBe('Schreiben')
    expect(box.textContent).toContain('Meine Werte')
    expect(box.textContent).toContain('Schreibimpulse')
  })

  it('has the language beside the profile and Immich beside the tokens', async () => {
    await show('/konto')
    expect(box.textContent).toContain('Sprache')
    await act(async () => root.unmount())
    box.remove()
    await show('/konto?tab=connections')
    expect(box.textContent).toContain('Immich')
    expect(box.textContent).toContain('API')
  })

  it('lets a phone reach every tab: the row scrolls sideways in its own line', async () => {
    await show('/konto')
    const row = box.querySelector('[role="tablist"]')!
    expect(row.className).toContain('overflow-x-auto')
    expect(row.className).toContain('sm:flex-wrap')
    expect([...row.querySelectorAll('[role="tab"]')].every((tab) => tab.className.includes('shrink-0'))).toBe(true)
  })
})

describe('Settings', () => {
  it('has one row of ten tabs for the operator', async () => {
    await show('/einstellungen')
    expect(tabs()).toEqual(['Konten', 'Anmeldung', 'Mail', 'KI', 'Immich', 'Web Push', 'Sicherung', 'Sprachen', 'Log', 'API'])
    expect(box.querySelectorAll('[role="tablist"]')).toHaveLength(1)
    expect(selected()).toBe('Konten')
  })

  it('sends a member to their account', async () => {
    asked.role = 'member'
    await show('/einstellungen')
    expect(where()).toBe('/konto')
    expect(tabs()).toContain('Profil')
  })

  it('knows the addresses of before: a part by its old name, the personal tabs at their new place', async () => {
    await show('/einstellungen?tab=server&sub=mail')
    expect(selected()).toBe('Mail')
    await act(async () => root.unmount())
    box.remove()
    await show('/einstellungen?tab=signin')
    expect(selected()).toBe('Anmeldung')
    await act(async () => root.unmount())
    box.remove()
    await show('/einstellungen?tab=looks')
    expect(where()).toBe('/konto?tab=looks')
    expect(selected()).toBe('Aussehen')
    await act(async () => root.unmount())
    box.remove()
    await show('/einstellungen?tab=general')
    expect(where()).toBe('/konto?tab=writing')
    await act(async () => root.unmount())
    box.remove()
    await show('/einstellungen?tab=nonsense')
    expect(selected()).toBe('Konten')
  })

  it('puts a changed tab in the address', async () => {
    await show('/einstellungen')
    const api = [...box.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.trim() === 'API')!
    await act(async () => api.click())
    expect(where()).toBe('/einstellungen?tab=api')
  })
})
