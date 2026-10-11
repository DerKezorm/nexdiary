/**
 * Sign-in through providers in the interface, against a stand-in of the server, as the shared sign-in blueprint lays it
 * out (part 04): the sign-in page with a button per provider and the operator's way in when the password is off, a
 * code a way back put in the address told in the module's words, the invitation page, the own account with a row per
 * provider, and Settings, Server, Sign-in with its three cards (the question before the public address changes, the
 * provider list and its form, the authentik card with its steps and reasons), the marks in the account list.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import type { Me, OidcProvider } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { idle } from '../test/wait'
import { ApiTokens } from '../components/ApiTokens'
import { AccountPage } from './AccountPage'
import { ReadinessCard } from './settings/ReadinessCards'
import { InvitePage, LoginPage } from './AuthPages'
import { AccountsCard, type ServerSettings } from './settings/ServerCards'
import { SignInPart } from './settings/SignInCards'

const went: string[] = []
vi.mock('../lib/providers', async (original) => ({ ...(await original<typeof import('../lib/providers')>()), go: (url: string) => went.push(url) }))

const me: Me = {
  id: 1, name: 'jule', display_name: 'Jule', role: 'operator', sign_in: 'password', email: 'jule@example.com', language: 'de',
  two_factor: true, totp: true, passkeys: 0, two_factor_recovery_left: 8, avatar: null, version: '0.1.0', whats_new_seen: '0.1.0',
  session_stage: 'full', second_factor_required: true,
  profile: {
    palette: 'salbei', mode: 'light', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true,
    notify_login: true, reminder: { mode: 'never', time: '20:30', days: 2, skip_if_written: true, with_prompt: true },
  },
}
const auth = { status: 'signedOut' as string, me: me as Me | null, setMe: vi.fn(), refresh: vi.fn(async () => undefined), signOut: vi.fn(async () => undefined) }
vi.mock('../state/auth', () => ({ useAuth: () => auth, safeNext: (next: string | null) => next ?? '/' }))

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let answers: Record<string, unknown> = {}

/** An answer the stand-in gives with a status of its own: `{ status, detail }`. */
type Refusal = { status: number; detail: Record<string, unknown> }

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      let found = answers[`${method} ${url}`]
      if (typeof found === 'function') found = (found as (body: unknown) => unknown)(body)
      if (found === 204) return new Response(null, { status: 204 })
      if (found && typeof found === 'object' && 'status' in found && 'detail' in found) {
        const refusal = found as Refusal
        return new Response(JSON.stringify({ detail: refusal.detail }), { status: refusal.status, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify(found ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function show(element: React.ReactNode, at = '/login', path = '*'): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path={path} element={element} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await idle()
}

function button(text: string, within: ParentNode = document): HTMLButtonElement | undefined {
  return [...within.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)
}

async function click(target: HTMLElement | undefined): Promise<void> {
  expect(target).toBeTruthy()
  await act(async () => target!.click())
  await idle()
}

async function type(input: HTMLInputElement | null | undefined, value: string): Promise<void> {
  expect(input).toBeTruthy()
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
  await act(async () => {
    setter.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await idle()
}

function field(label: string, within: ParentNode = document): HTMLInputElement | null {
  const found = [...within.querySelectorAll('label')].find((item) => item.textContent?.startsWith(label))
  return found?.querySelector('input') ?? null
}

async function submit(form: HTMLFormElement | null | undefined): Promise<void> {
  expect(form).toBeTruthy()
  await act(async () => form!.requestSubmit())
  await idle()
}

const PROVIDERS = [{ slug: 'authentik', label: 'authentik' }, { slug: 'entra', label: 'Microsoft' }]

beforeEach(async () => {
  await changeLanguage('de', false)
  auth.status = 'signedOut'
  auth.me = me
  went.length = 0
  answers = { 'GET /api/auth/methods': { password: true, providers: PROVIDERS, passkeys: false, forgot: false } }
  serve()
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('the sign-in page', () => {
  it('has the password form, the line "oder" and a button per provider in the order of the list', async () => {
    await show(<LoginPage />)
    expect(field('Passwort', box)).toBeTruthy()
    expect(box.textContent).toContain('oder')
    const buttons = [...box.querySelectorAll('[data-testid="provider-buttons"] button')].map((item) => item.textContent)
    expect(buttons).toEqual(['Mit authentik anmelden', 'Mit Microsoft anmelden'])
    await click(button('Mit Microsoft anmelden'))
    expect(went).toEqual(['/api/oidc/entra/start'])
  })

  it('without password sign-in shows the buttons only, and the operator finds the form behind a small link', async () => {
    answers['GET /api/auth/methods'] = { password: false, providers: PROVIDERS, passkeys: false, forgot: false }
    await show(<LoginPage />)
    expect(field('Passwort', box)).toBeNull()
    expect(button('Mit authentik anmelden')).toBeTruthy()
    await click(button('Als Betreiber mit Passwort anmelden'))
    expect(field('Passwort', box)).toBeTruthy()
  })

  it('tells a code from the way back in the words of the shared module, never the code itself', async () => {
    await show(<LoginPage />, '/login?error=oidc_no_account')
    const alert = box.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain('Für dich gibt es hier kein Konto. Bitte um eine Einladung')
    expect(alert).toContain('in deinen Kontoeinstellungen')
    expect(alert).not.toContain('oidc_no_account')
    act(() => root.unmount())
    box.remove()
    await show(<LoginPage />, '/login?error=too_many_attempts')
    expect(box.querySelector('[role="alert"]')?.textContent).toContain('Zu viele Versuche. Warte einen Moment und versuch es dann noch einmal.')
  })
})

describe('the invitation page', () => {
  it('takes the invitation along to the provider: "Weiter mit …"', async () => {
    answers['GET /api/invite/key-1'] = { min_password: 10, signed_in_as: null }
    await show(<InvitePage />, '/einladung/key-1', '/einladung/:token')
    await click(button('Weiter mit authentik'))
    expect(went).toEqual(['/api/oidc/authentik/start?invite=key-1'])
  })
})

describe('the own account', () => {
  beforeEach(() => {
    auth.status = 'signedIn'
    answers['GET /api/oidc/me'] = [{ slug: 'authentik', label: 'authentik', linked: true }, { slug: 'entra', label: 'Microsoft', linked: false }]
    answers['GET /api/auth/sessions'] = []
    answers['GET /api/auth/passkeys'] = []
  })

  it('has a row per provider: linked can be undone, not linked asks for the password and goes there', async () => {
    answers['POST /api/oidc/entra/link'] = { url: 'https://login.example.com/authorize?x=1' }
    answers['DELETE /api/oidc/authentik/link'] = 204
    await show(<AccountPage />, '/konto?tab=security')
    const rows = [...box.querySelectorAll('[data-testid="my-providers"] li')].map((item) => item.textContent)
    expect(rows[0]).toContain('authentik')
    expect(rows[0]).toContain('Verknüpft')
    expect(rows[1]).toContain('Nicht verknüpft')
    await click(button('Verknüpfen: Microsoft'))
    await type(field('Passwort', box.querySelector('[data-testid="my-providers"]')!), 'my password')
    await submit(box.querySelector<HTMLFormElement>('[data-testid="my-providers"] form'))
    expect(calls.find((call) => call.url === '/api/oidc/entra/link')?.body).toEqual({ password: 'my password' })
    expect(went).toEqual(['https://login.example.com/authorize?x=1'])
    await click(button('Lösen: authentik'))
    expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/oidc/authentik/link')).toBe(true)
  })

  it('an account through one provider only keeps its last link and says so', async () => {
    auth.me = { ...me, sign_in: 'oidc' }
    await show(<AccountPage />, '/konto?tab=security')
    expect(box.textContent).toContain('Dieses Konto meldet sich nur über authentik an.')
    expect(button('Lösen: authentik')).toBeUndefined()
    expect(button('Verknüpfen: Microsoft')).toBeUndefined()
  })

  it('back from the provider: the confirmation, or what went wrong in the module\'s words', async () => {
    await show(<AccountPage />, '/konto?linked=entra')
    expect(box.textContent).toContain('Dein Konto ist jetzt mit Microsoft verknüpft.')
    act(() => root.unmount())
    box.remove()
    await show(<AccountPage />, '/konto?error=oidc_subject_taken')
    expect(box.textContent).toContain('Diese Identität ist schon mit einem anderen Konto verknüpft.')
  })
})

// --- Settings, Server, Sign-in ---------------------------------------------------------------------------------------

const settings: ServerSettings = {
  public_url: 'https://diary.example.com', password_login: true, two_factor_required: true, master_key_saved_at: null,
  backup_schedule: 'daily', backup_keep: 7, smtp_host: '', smtp_port: 587, smtp_security: 'starttls', smtp_user: '', smtp_password_set: false, smtp_from: '',
  api_tokens_allowed: true, update_check: true, storage_per_person_gb: 5,
}

function entry(change: Partial<OidcProvider> = {}): OidcProvider {
  return {
    id: 1, slug: 'authentik', label: 'authentik', issuer: 'https://auth.example.com/application/o/nexdiary', client_id: 'id-1', has_secret: true,
    scopes: 'openid profile email', enabled: true, auto_create: false, trusts_second_factor: true, managed: 'authentik', position: 0,
    redirect_uri: 'https://diary.example.com/api/oidc/authentik/callback', links: 2, editable: true, ...change,
  }
}

const ADDRESS = { public_url: 'https://diary.example.com', seen: 'https://diary.example.com', forwarded_proto: '', forwarded_host: '', proxy_ignored: false, callback_path: '/api/oidc/authentik/callback', stale: null }

function SignInWithServer({ server }: { server: Parameters<typeof SignInPart>[0]['server'] }) {
  return <SignInPart server={server} />
}

async function showCards(providers: OidcProvider[] = [entry()], address: Record<string, unknown> = ADDRESS): Promise<{ saved: unknown[] }> {
  answers['GET /api/oidc/admin/providers'] = providers
  answers['GET /api/oidc/authentik/address'] = address
  const saved: unknown[] = []
  const server = {
    settings,
    save: vi.fn(async (change: unknown) => saved.push(change)),
    saveNow: vi.fn(),
    reload: vi.fn(async () => undefined),
    saveAddress: vi.fn(async (url: string, confirm: boolean) => {
      saved.push({ public_url: url, confirm })
      return confirm ? null : { count: 1, hand: 2, address: 'https://diary.example.com/api/oidc/authentik/callback' }
    }),
    setSettings: vi.fn(),
    busy: false,
    problem: null,
    done: null,
    values: {},
    run: vi.fn(),
  } as unknown as Parameters<typeof SignInPart>[0]['server']
  await show(<SignInWithServer server={server} />, '/einstellungen?tab=signin')
  return { saved }
}

describe('Settings, Server, Sign-in', () => {
  it('has the three cards in their order, and password sign-in stays on while no provider is active', async () => {
    await showCards([entry({ enabled: false })])
    const titles = [...box.querySelectorAll('h2, h3')].map((item) => item.textContent)
    expect(titles).toEqual(['Anmeldung', 'Anmeldeanbieter', 'authentik in einem Schritt'])
    const password = box.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Anmeldung mit Passwort"]')
    expect(password?.disabled).toBe(true)
  })

  it('asks before the public address changes what authentik and the providers by hand know, and sends again when told so', async () => {
    const { saved } = await showCards()
    await type(field('Öffentliche Adresse'), 'https://new.example.com')
    await submit(field('Öffentliche Adresse')!.closest('form'))
    const question = document.querySelector('[role="dialog"]')?.textContent ?? ''
    expect(question).toContain('authentik kennt noch die Rückleitadresse https://diary.example.com/api/oidc/authentik/callback.')
    expect(question).toContain('Bei 2 von Hand eingetragenen Anbietern musst du die Rückleitadresse dort selbst anpassen.')
    await submit(document.querySelector<HTMLFormElement>('[role="dialog"] form'))
    expect(saved).toEqual([{ public_url: 'https://new.example.com', confirm: false }, { public_url: 'https://new.example.com', confirm: true }])
  })

  it('lists the providers with their marks, and the form has its fields in the order of the blueprint', async () => {
    await showCards()
    const row = box.querySelector('[data-testid="provider-list"] li')?.textContent ?? ''
    expect(row).toContain('aktiv')
    expect(row).toContain('über authentik eingerichtet')
    await click(button('Anbieter hinzufügen'))
    const form = document.querySelector('[data-testid="provider-form"]')!
    const labels = [...form.querySelectorAll('label')].map((item) => item.querySelector('span')?.textContent ?? item.textContent)
    expect(labels.slice(0, 5)).toEqual(['Name auf dem Knopf', 'Kurzname', 'Aussteller (Issuer)', 'Client-ID', 'Client-Geheimnis'])
    const switches = [...form.querySelectorAll('[role="switch"]')].map((item) => [item.getAttribute('aria-label'), item.getAttribute('aria-checked')])
    expect(switches).toEqual([['Aktiv', 'true'], ['Neue Personen bekommen ein Konto', 'false'], ['Der Anbieter prüft den zweiten Faktor selbst', 'true']])
    await type(field('Name auf dem Knopf', form), 'Mein Login')
    expect(field('Kurzname', form)?.value).toBe('mein-login')
    expect((form.querySelector('input[readonly]') as HTMLInputElement).value).toBe('https://diary.example.com/api/oidc/mein-login/callback')
  })

  it('asks how many accounts lose the link before a provider goes', async () => {
    answers['GET /api/oidc/admin/providers/1/impact'] = { issuer_change: 0, count: 2, only: 1, only_names: ['olga'] }
    answers['DELETE /api/oidc/admin/providers/1'] = { count: 2, only: 1, only_names: ['olga'] }
    await showCards()
    await click(button('Entfernen: authentik'))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('„authentik“ entfernen? 2 Konten verlieren die Verknüpfung, für 1 davon ist es der einzige Weg herein.')
    await submit(document.querySelector<HTMLFormElement>('[role="dialog"] form'))
    expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/oidc/admin/providers/1')).toBe(true)
  })

  it('shows the steps of the authentik button by name, with the reason of the one that failed', async () => {
    answers['POST /api/oidc/authentik/setup'] = {
      ok: false, client_id: '', issuer: '', provider_id: null, links_dropped: 0,
      steps: [{ key: 'reached', ok: true, detail: 'x' }, { key: 'signingKey', ok: false, detail: 'y', reason: 'token', status: 403 }],
    }
    await showCards([])
    expect(box.textContent).toContain('Noch kein Anbieter. Richte authentik unten in einem Schritt ein oder trag einen Anbieter von Hand ein.')
    await type(field('Adresse von authentik'), 'https://auth.example.com')
    await type(field('API-Token'), 'token-1')
    await submit(field('API-Token')!.closest('form'))
    const steps = box.querySelector('[data-testid="authentik-steps"]')?.textContent ?? ''
    expect(steps).toContain('Verbindung zu authentik')
    expect(steps).toContain('Schlüssel zum Signieren')
    expect(steps).toContain('authentik hat das Token nicht angenommen (Antwort 403).')
    expect(field('API-Token')?.value).toBe('token-1')
  })

  it('without a public address proposes the one of this browser and sets up with it', async () => {
    answers['POST /api/oidc/authentik/setup'] = { ok: true, client_id: 'c', issuer: 'i', provider_id: 1, links_dropped: 0, steps: [], public_url: window.location.origin }
    await showCards([], { ...ADDRESS, public_url: '' })
    expect(box.querySelector('[data-testid="authentik-proposal"]')?.textContent).toBe(window.location.origin)
    await type(field('Adresse von authentik'), 'https://auth.example.com')
    await type(field('API-Token'), 'token-1')
    await click(button('Übernehmen und einrichten'))
    expect(calls.find((call) => call.url === '/api/oidc/authentik/setup')?.body).toEqual({
      url: 'https://auth.example.com', token: 'token-1', confirm_issuer_change: false, public_url: window.location.origin,
    })
  })
})

describe('the account list', () => {
  it('marks the providers of an account and takes a link with the own password', async () => {
    auth.status = 'signedIn'
    answers['GET /api/accounts'] = [
      { ...me, id: 2, name: 'alex', role: 'member', locked: false, created_at: '2026-10-01T10:00:00Z', last_seen_at: null, ai_allowed: true, immich_allowed: true,
        providers: [{ id: 7, slug: 'authentik', label: 'authentik' }] },
    ]
    answers['GET /api/invites'] = []
    answers['DELETE /api/oidc/admin/accounts/2/links/7'] = 204
    await show(<AccountsCard />, '/einstellungen')
    expect(box.querySelector('[data-testid="account-providers"]')?.textContent).toBe('authentik')
    await click(button('Mehr für alex'))
    await click(button('Verknüpfung mit authentik lösen'))
    await type(field('Dein eigenes Passwort', document.querySelector('[role="dialog"]')!), 'operator password')
    await submit(document.querySelector<HTMLFormElement>('[role="dialog"] form'))
    expect(calls.find((call) => call.url === '/api/oidc/admin/accounts/2/links/7')?.body).toEqual({ current_password: 'operator password' })
  })
})

describe('what a provider that checks the second factor leaves waiting', () => {
  it('says at the tokens that they work only once the account has a factor of its own, and making one stays possible', async () => {
    auth.status = 'signedIn'
    answers['GET /api/api-tokens'] = { allowed: true, second_factor_pending: true, tokens: [
      { id: 1, name: 'Dashboard', level: 'read', prefix: 'nxd_ab', created_at: '2026-10-01T10:00:00Z', last_used_at: null, expires_at: null, blocked: false }] }
    await show(<ApiTokens />, '/konto?tab=connections')
    const note = box.querySelector('[data-testid="api-tokens-waits"]')
    expect(note?.textContent).toContain('Wirkt erst, wenn du einen zweiten Faktor einrichtest.')
    expect(note?.querySelector('a')?.getAttribute('href')).toBe('/konto?tab=security')
    expect(box.querySelector('[data-testid="api-token-waits"]')).toBeTruthy()
  })

  it('"Ready for the internet?" names the providers trusted with the second factor', async () => {
    answers['GET /api/settings/readiness'] = { open: 1, points: [{ key: 'two_factor', state: 'warn', values: { providers: 'authentik', count: 1 } }] }
    await show(<ReadinessCard />, '/einstellungen')
    expect(box.textContent).toContain('Bei authentik prüft der Anbieter den zweiten Faktor selbst')
  })
})
