/**
 * Photos shared while nobody is signed in: the quick note sends to the sign-in with its address (the share waits in the
 * browser meanwhile, untouched), and once fully signed in the photos still arrive, also after a sign-on through a
 * provider that came back without that address. Signing out leaves nothing of a share behind for the next person.
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'

import '../i18n'
import { changeLanguage } from '../i18n'
import { FakeCacheStorage, keepShare } from '../test/fakeCaches'
import { idle, until } from '../test/wait'

/** What the stand-in of the sign-in says; the provider itself is tested at the end with its real self. */
const auth: { status: string; me: Record<string, unknown> | null; refresh: () => Promise<void>; setMe: () => void; signOut: () => Promise<void> } = {
  status: 'signedOut',
  me: null,
  refresh: async () => undefined,
  setMe: () => undefined,
  signOut: async () => undefined,
}
vi.mock('./auth', async (real) => {
  const actual = await real<typeof import('./auth')>()
  return { ...actual, useAuth: () => auth }
})

const ME = {
  id: 'u1',
  name: 'jule',
  display_name: 'Jule',
  role: 'member',
  session_stage: 'full',
  second_factor_setup_required: false,
  profile: { palette: 'salbei', mode: 'system', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true },
}

let calls: { method: string; url: string }[] = []

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/today') return json({ date: '2026-10-10', notes: [], day: null, values: [], streak: 0, photos: [], night: { active: false }, catch_up: { count: 0, days: [] } })
      if (url.startsWith('/api/photos?') && method === 'POST') return json({ id: 'a'.repeat(32), date: '2026-10-10', source: 'upload', width: 4, height: 3, created_at: '2026-10-10T09:00:00+00:00', on_note: true }, 201)
      if (url === '/api/notes' && method === 'POST') {
        const sent = JSON.parse(String(init!.body)) as { id: string; text: string; photo_id: string }
        return json({ id: sent.id, date: '2026-10-10', text: sent.text, prompt: null, photo_id: sent.photo_id, created_at: '2026-10-10T09:00:00+00:00', updated_at: null, unreadable: false }, 201)
      }
      if (url === '/api/auth/methods') return json({ password: true, oidc: true, oidc_name: 'authentik' })
      if (url === '/api/auth/totp/begin') return json({ secret: 'A'.repeat(32), uri: 'otpauth://totp/nexdiary:jule', qr_svg: '<svg/>' })
      return json({})
    }),
  )
}

let root: Root
let box: HTMLDivElement
let storage: FakeCacheStorage
let address = ''

function Where() {
  const location = useLocation()
  useEffect(() => {
    address = location.pathname + location.search
  }, [location])
  return null
}

async function show(entry: string): Promise<void> {
  const { default: App } = await import('../App')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <App />
        <Where />
      </MemoryRouter>,
    ),
  )
  await idle()
}

const ID = '5ba7e000-0000-4000-8000-0000000000a1'
const OTHER = '5ba7e000-0000-4000-8000-0000000000a2'
/** The quick note takes each share in once per page load: a test that lets it take one uses an id of its own. */
const LATER = '5ba7e000-0000-4000-8000-0000000000a3'

beforeEach(async () => {
  Element.prototype.scrollTo ??= () => undefined
  await changeLanguage('de', false)
  storage = new FakeCacheStorage(window.location.origin)
  vi.stubGlobal('caches', storage)
  auth.status = 'signedOut'
  auth.me = null
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

const notes = () => calls.filter((call) => call.method === 'POST' && call.url === '/api/notes')

describe('photos shared while nobody is signed in', () => {
  it('wait in the browser while the sign-in asks, and the way back keeps their address', async () => {
    await keepShare(storage, ID, Date.now(), [new Blob([new Uint8Array(9)], { type: 'image/jpeg' })], { text: 'vom bahnhof' })
    await show(`/schnell?geteilt=${ID}`)
    expect(address).toBe(`/login?next=${encodeURIComponent(`/schnell?geteilt=${ID}`)}`)
    expect(storage.addresses()).toHaveLength(2)
    expect(calls.some((call) => call.url.startsWith('/api/photos'))).toBe(false)
  })

  it('wait while the second factor is still being set up after the password', async () => {
    auth.status = 'signedIn'
    auth.me = { ...ME, session_stage: 'setup' }
    await keepShare(storage, ID, Date.now(), [new Blob([new Uint8Array(9)], { type: 'image/jpeg' })])
    await show(`/schnell?geteilt=${ID}`)
    expect(address.startsWith('/login?next=')).toBe(true)
    expect(storage.addresses()).toHaveLength(2)
  })

  it('arrive once fully signed in, through the address the way back carried', async () => {
    auth.status = 'signedIn'
    auth.me = ME
    await keepShare(storage, ID, Date.now(), [new Blob([new Uint8Array(9)], { type: 'image/jpeg' })], { text: 'vom bahnhof' })
    await show(`/schnell?geteilt=${ID}`)
    await until(() => notes().length === 1, 'the note')
    await idle()
    expect(storage.addresses()).toEqual([])
    expect(address).toBe('/schnell')
  })

  it('arrive also after a sign-on that came back without the address: the app leads to the quick note itself', async () => {
    auth.status = 'signedIn'
    auth.me = ME
    await keepShare(storage, OTHER, Date.now() - 60 * 1000, [new Blob([new Uint8Array(9)], { type: 'image/jpeg' })])
    await keepShare(storage, LATER, Date.now(), [new Blob([new Uint8Array(9)], { type: 'image/jpeg' })], { text: 'vom bahnhof' })
    await show('/')
    await until(() => notes().length === 1, 'the note')
    await idle()
    expect(address).toBe('/schnell')
    // The newest share came in; the older one waits for its half hour, or for the sign-out.
    expect(storage.addresses().every((item) => item.includes(OTHER))).toBe(true)
  })

  it('are not looked for while the second factor still has to be set up', async () => {
    auth.status = 'signedIn'
    auth.me = { ...ME, second_factor_setup_required: true }
    await keepShare(storage, ID, Date.now(), [new Blob([new Uint8Array(9)], { type: 'image/jpeg' })])
    await show('/konto')
    expect(address).toBe('/konto')
    expect(storage.addresses()).toHaveLength(2)
  })
})

describe('signing out', () => {
  it('clears every share that waits', async () => {
    vi.doUnmock('./auth')
    vi.resetModules()
    const { AuthProvider, useAuth } = await import('./auth')
    const fresh = new FakeCacheStorage(window.location.origin)
    vi.stubGlobal('caches', fresh)
    await keepShare(fresh, ID, Date.now(), [new Blob([new Uint8Array(9)], { type: 'image/jpeg' })])
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
        if (url === '/api/setup') return json({ needs_setup: false, signed_in: true })
        if (url === '/api/auth/me') return json(ME)
        if (url === '/api/auth/logout') return new Response(null, { status: 204 })
        return json({})
      }),
    )
    let signOut: () => Promise<void> = async () => undefined
    function Grab() {
      const given = useAuth().signOut
      useEffect(() => {
        signOut = given
      }, [given])
      return null
    }
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    box = document.createElement('div')
    document.body.appendChild(box)
    root = createRoot(box)
    await act(async () =>
      root.render(
        <AuthProvider>
          <Grab />
        </AuthProvider>,
      ),
    )
    await idle()
    expect(fresh.addresses()).toHaveLength(2)
    await act(async () => signOut())
    expect(fresh.addresses()).toEqual([])
  })
})
