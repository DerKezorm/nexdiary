/**
 * My account, Look: the five colours as pictures and light, dark or as the system. A choice shows at once, is kept
 * with the account (never only in this browser) and survives the next load as a preview before the page has asked
 * the server; what the account says wins over what the browser remembered.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import type { Me } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { storedPalette } from '../lib/theme'
import { AccountPage } from './AccountPage'
import { idle } from '../test/wait'

const setMe = vi.fn()
const me: Me = {
  id: 1, name: 'jule', display_name: 'Jule', role: 'member', sign_in: 'password', email: 'jule@example.com', language: 'de',
  oidc_linked: false, two_factor: true, totp: true, passkeys: 0, two_factor_recovery_left: 10, avatar: null, version: '0.1.0', whats_new_seen: '0.1.0',
  profile: { palette: 'salbei', mode: 'light', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true },
}
vi.mock('../state/auth', () => ({ useAuth: () => ({ me, setMe }) }))

let sent: Record<string, unknown>[] = []
let root: Root
let box: HTMLDivElement
let kept: Map<string, string>

beforeEach(async () => {
  await changeLanguage('de', false)
  sent = []
  kept = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/me/preferences') {
        const body = JSON.parse(String(init?.body))
        sent.push(body)
        return new Response(JSON.stringify({ ...me.profile, ...body }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  document.documentElement.removeAttribute('data-palette')
  document.documentElement.removeAttribute('data-theme')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => root.render(<MemoryRouter initialEntries={['/konto?tab=looks']}><AccountPage /></MemoryRouter>))
})

afterEach(async () => {
  await act(async () => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

function choice(name: string): HTMLButtonElement {
  const found = [...box.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((item) => item.textContent?.includes(name))
  expect(found, name).toBeTruthy()
  return found!
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click())
  await idle()
}

describe('the themes of the account', () => {
  it('shows five colours, each as a light and a dark picture, with the current one marked', () => {
    const names = [...box.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].map((item) => item.textContent ?? '')
    const five = ['Salbei', 'Terrakotta', 'Pflaume', 'Altrosa', 'Tinte']
    expect(five.every((name) => names.some((text) => text.includes(name)))).toBe(true)
    expect(box.querySelectorAll('[data-swatch="light"]')).toHaveLength(5)
    expect(box.querySelectorAll('[data-swatch="dark"]')).toHaveLength(5)
    expect(choice('Salbei').getAttribute('aria-pressed')).toBe('true')
    expect(choice('Tinte').getAttribute('aria-pressed')).toBe('false')
  })

  it('applies a colour at once, saves it with the account and keeps it as the preview for the next load', async () => {
    await click(choice('Pflaume'))
    expect(document.documentElement.getAttribute('data-palette')).toBe('pflaume')
    expect(sent).toEqual([{ palette: 'pflaume' }])
    expect(storedPalette()).toBe('pflaume')
    expect(choice('Pflaume').getAttribute('aria-pressed')).toBe('true')
    // Sage is the page's own colour: it needs no attribute.
    await click(choice('Salbei'))
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false)
    expect(sent.at(-1)).toEqual({ palette: 'salbei' })
  })

  it('saves light and dark apart from the colour', async () => {
    const dark = [...box.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find((item) => item.textContent === 'Dunkel')!
    await click(dark)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(sent).toEqual([{ mode: 'dark' }])
  })

  it('speaks English as well', async () => {
    await act(async () => void changeLanguage('en', false))
    expect(box.textContent).toContain('Dusty rose')
    expect(box.textContent).toContain('Light or dark')
  })
})
