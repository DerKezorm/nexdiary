/**
 * A locked day on the pages that show it: the day being read (the lock button with its question, the mark, no way to
 * edit or change the cover once locked), the journal (the lock on its entry), and the operator's switches per account
 * (the AI, Immich) in the list of accounts.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import '../i18n'
import { changeLanguage } from '../i18n'
import { EntryPage } from './EntryPage'
import { JournalPage } from './JournalPage'
import { AccountsCard } from './settings/ServerCards'

vi.mock('../state/auth', () => ({
  useAuth: () => ({ me: { id: 1, name: 'jule', display_name: 'Jule', sign_in: 'password', profile: { mode: 'light', layout: 'page', journal: 'blog', timezone: 'Europe/Berlin' } } }),
}))

const DATE = '2026-10-06'
type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let day: Record<string, unknown> = {}
let accounts: Record<string, unknown>[] = []

function page(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { date: DATE, title: 'Kastanien', text: 'Ein langer Tag.', tags: ['herbst'], values: {}, cover: 'illu:baum.abend.herbst', cover_chosen: false, written_by: 'self', words: 3, revision: 2, locked: false, locked_at: null, created_at: '', updated_at: '', ...extra }
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
      if (url === `/api/days/${DATE}/lock` && method === 'POST') {
        day = page({ locked: true, locked_at: '2026-10-07T10:00:00+00:00' })
        return json(day)
      }
      if (url === `/api/days/${DATE}`) return json(day)
      if (url === `/api/days/${DATE}/shares`) return json({ date: DATE, people: [], with_values: false, with_notes: false })
      if (url === '/api/journal' && method === 'POST') return json({ days: [{ date: DATE, title: 'Kastanien', excerpt: 'Ein langer Tag.', tags: [], cover: 'illu:baum.abend.herbst', written_by: 'self', first_value: null, shared_with: [], locked: true, unreadable: false }], more: false })
      if (url === '/api/journal/overview') return json({ count: 1, since: DATE, tags: [] })
      if (url === '/api/catch-up') return json({ count: 0, days: [] })
      if (url === '/api/accounts') return json(accounts)
      if (url === '/api/invites') return json([])
      if (url.startsWith('/api/accounts/') && url.endsWith('/permissions') && method === 'PUT') return json({ ai_allowed: true, immich_allowed: true, ...body })
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function settle(ms = 20): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)))
}

async function mount(element: React.ReactNode): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => root.render(element))
  await settle(40)
}

const entry = () =>
  mount(
    <MemoryRouter initialEntries={[`/tag/${DATE}`]}>
      <Routes>
        <Route path="/tag/:date" element={<EntryPage />} />
      </Routes>
    </MemoryRouter>,
  )

beforeEach(async () => {
  await changeLanguage('de', false)
  day = page()
  accounts = []
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('reading a day', () => {
  it('has the lock button with its edit and cover buttons while the day is open', async () => {
    await entry()
    const labels = [...box.querySelectorAll('a, button')].map((item) => item.textContent?.trim())
    expect(labels).toContain('Bearbeiten')
    expect(labels).toContain('Für immer verschließen')
    expect(labels).toContain('Titelbild ändern')
    expect(box.querySelector('[data-locked-mark]')).toBeNull()
  })

  it('asks what locking means, asks for the word, and then shows the day locked', async () => {
    await entry()
    await act(async () => [...box.querySelectorAll('button')].find((item) => item.textContent?.includes('Für immer verschließen'))!.click())
    const dialog = document.querySelector('[role=dialog]')!
    expect(dialog.textContent).toContain('lässt sich danach nie mehr ändern oder löschen')
    expect(dialog.textContent).toContain('Zur Bestätigung „verschließen“ eintippen')
    const confirm = [...dialog.querySelectorAll('button')].find((item) => item.textContent?.includes('Für immer verschließen'))!
    expect(confirm.disabled).toBe(true)
    // A click on the confirm button without the word does nothing at all, nor does Enter in the field.
    await act(async () => confirm.click())
    const input = dialog.querySelector('input')!
    await act(async () => dialog.querySelector('form')!.requestSubmit())
    expect(calls.some((call) => call.url.endsWith('/lock'))).toBe(false)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'verschließen')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => confirm.click())
    await settle(40)
    expect(calls.filter((call) => call.url.endsWith('/lock'))).toHaveLength(1)
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(box.querySelector('[data-locked-mark]')).not.toBeNull()
    const labels = [...box.querySelectorAll('a, button')].map((item) => item.textContent?.trim())
    expect(labels).not.toContain('Bearbeiten')
    expect(labels).not.toContain('Titelbild ändern')
    expect(labels.some((label) => label?.includes('Für immer verschließen') && label !== 'Für immer verschlossen')).toBe(false)
    expect(box.textContent).toContain('Verschlossen am 7. Oktober 2026')
    // Sharing stays.
    expect(labels).toContain('Teilen')
  })

  it('shows a locked day as locked at once: no edit, no cover change, no lock', async () => {
    day = page({ locked: true, locked_at: '2026-10-05T08:00:00+00:00' })
    await entry()
    const labels = [...box.querySelectorAll('a, button')].map((item) => item.textContent?.trim())
    expect(labels).not.toContain('Bearbeiten')
    expect(labels).not.toContain('Titelbild ändern')
    expect(labels).not.toContain('Für immer verschließen')
    expect(labels).toContain('Teilen')
    expect(box.textContent).toContain('Für immer verschlossen')
    expect(box.textContent).toContain('Verschlossen am 5. Oktober 2026')
  })

  it('names the lock in English too', async () => {
    await changeLanguage('en', false)
    day = page({ locked: true, locked_at: '2026-10-05T08:00:00+00:00' })
    await entry()
    expect(box.textContent).toContain('Locked for good')
    expect(box.textContent).toContain('Locked on October 5, 2026')
  })
})

describe('the journal', () => {
  it('marks a locked day with a lock the screen reader names', async () => {
    await mount(
      <MemoryRouter>
        <JournalPage />
      </MemoryRouter>,
    )
    const mark = box.querySelector('[data-locked-mark]')!
    expect(mark).not.toBeNull()
    expect(mark.textContent).toContain('Für immer verschlossen')
  })
})

describe('the accounts of the operator', () => {
  it('has a check for the AI and one for Immich on every account, on from the start, and changes only the one touched', async () => {
    accounts = [
      { id: 1, name: 'jule', display_name: 'Jule', role: 'operator', sign_in: 'password', two_factor: true, locked: false, blocked: false, has_password: true, avatar: null, created_at: '', last_seen_at: null, ai_allowed: true, immich_allowed: true },
      { id: 2, name: 'ben', display_name: '', role: 'member', sign_in: 'password', two_factor: true, locked: false, blocked: false, has_password: true, avatar: null, created_at: '', last_seen_at: null, ai_allowed: true, immich_allowed: false },
    ]
    await mount(
      <MemoryRouter>
        <AccountsCard />
      </MemoryRouter>,
    )
    const boxes = [...box.querySelectorAll<HTMLInputElement>('[data-permissions] input[type=checkbox]')]
    expect(boxes.map((item) => item.checked)).toEqual([true, true, true, false])
    expect(boxes.map((item) => item.getAttribute('aria-label'))).toEqual(['KI erlaubt: Jule', 'Immich erlaubt: Jule', 'KI erlaubt: ben', 'Immich erlaubt: ben'])
    await act(async () => boxes[2].click())
    await settle(30)
    const puts = calls.filter((call) => call.method === 'PUT' && call.url.endsWith('/permissions'))
    expect(puts).toHaveLength(1)
    expect(puts[0]).toMatchObject({ url: '/api/accounts/2/permissions', body: { ai_allowed: false } })
    expect(Object.keys(puts[0].body!)).toEqual(['ai_allowed'])
    expect(box.querySelectorAll<HTMLInputElement>('[data-permissions] input')[2].checked).toBe(false)
    await act(async () => box.querySelectorAll<HTMLInputElement>('[data-permissions] input')[3].click())
    await settle(30)
    expect(calls.filter((call) => call.method === 'PUT' && call.url.endsWith('/permissions')).at(-1)).toMatchObject({ body: { immich_allowed: true } })
  })
})
