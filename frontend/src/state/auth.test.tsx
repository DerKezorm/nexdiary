/**
 * The account's looks win over what the browser remembered: after the page has asked the server, the colour and
 * light or dark of the account are painted, whatever an earlier visit (or another account on this browser) left behind.
 * And the script that paints a remembered choice before the first frame knows the five colours and nothing else.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../i18n'
import script from '../../public/theme.js?raw'
import { AuthProvider, useAuth } from './auth'

let root: Root
let box: HTMLDivElement
let kept: Map<string, string>

function Probe() {
  const { status } = useAuth()
  return <p>{status}</p>
}

function serve(profile: Record<string, unknown>): void {
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/setup') return json({ needs_setup: false, code_required: false, signed_in: true, version: '0.1.0', min_password: 12 })
      if (url === '/api/auth/me') {
        return json({ id: 1, name: 'jule', display_name: 'Jule', role: 'user', language: 'de', version: '0.1.0', whats_new_seen: '0.1.0', profile: { timezone: 'Europe/Berlin', timezone_source: 'manual', ...profile } })
      }
      return json({})
    }),
  )
}

async function start(): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => root.render(<AuthProvider><Probe /></AuthProvider>))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
}

beforeEach(() => {
  kept = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined }))
  document.documentElement.removeAttribute('data-palette')
  document.documentElement.removeAttribute('data-theme')
})

afterEach(async () => {
  await act(async () => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

describe('the looks of the account', () => {
  it('are painted once the server has said them, over what an earlier visit left in the browser', async () => {
    kept.set('nexdiary.palette', 'terrakotta')
    document.documentElement.setAttribute('data-palette', 'terrakotta')
    serve({ palette: 'pflaume', mode: 'dark' })
    await start()
    expect(document.documentElement.getAttribute('data-palette')).toBe('pflaume')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(kept.get('nexdiary.palette')).toBe('pflaume')
  })

  it('bring sage back when the account has sage and the browser remembered another colour', async () => {
    kept.set('nexdiary.palette', 'tinte')
    document.documentElement.setAttribute('data-palette', 'tinte')
    serve({ palette: 'salbei', mode: 'light' })
    await start()
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false)
    expect(kept.get('nexdiary.palette')).toBe('salbei')
  })

  it('ignore a colour that is none of the five', async () => {
    serve({ palette: 'neon', mode: 'light' })
    await start()
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false)
  })
})

describe('the script before the first frame', () => {
  function run(stored: Record<string, string>, dark = false): void {
    document.documentElement.removeAttribute('data-palette')
    document.documentElement.removeAttribute('data-theme')
    document.head.innerHTML = '<meta name="theme-color" content="#faf5ec">'
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored[key] ?? null })
    vi.stubGlobal('matchMedia', () => ({ matches: dark }))
    new Function(script)()
  }

  it('paints the colour and the mode of the last visit', () => {
    run({ 'nexdiary.palette': 'altrosa', 'nexdiary.theme': 'dark' })
    expect(document.documentElement.getAttribute('data-palette')).toBe('altrosa')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('paints nothing for sage, for nothing remembered and for a value that is no colour', () => {
    const cases: Record<string, string>[] = [{ 'nexdiary.palette': 'salbei' }, {}, { 'nexdiary.palette': '"><script>' }, { 'nexdiary.palette': 'neon' }]
    for (const stored of cases) {
      run(stored)
      expect(document.documentElement.hasAttribute('data-palette'), JSON.stringify(stored)).toBe(false)
    }
  })

  it('still follows the system for light or dark', () => {
    run({}, true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
