/**
 * Blog or timeline, switched right in the journal: two buttons with their state, kept with the account (the same choice
 * as the card under My account, Look), shown at once and put right if the server refuses; none in an empty journal.
 */
import { act, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import type { Profile } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { JournalPage } from './JournalPage'
import { idle } from '../test/wait'

const auth = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  return {
    listeners,
    me: { name: 'jule', profile: { journal: 'blog', timezone: 'Europe/Berlin' } } as { name: string; profile: Partial<Profile> },
  }
})

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
      setMe: (next: typeof auth.me) => {
        auth.me = next
        auth.listeners.forEach((listener) => listener())
      },
    }
  },
}))

const DAY = { date: '2026-10-05', title: 'Ein Tag', excerpt: 'Text', tags: [], cover: 'illu:baum.abend.herbst', written_by: 'self', first_value: null, shared_with: [], unreadable: false }

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let count = 1
let refuse = false

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/journal/overview') return json({ count, since: count ? '2026-10-05' : null, tags: [] })
      if (url === '/api/journal') return json({ days: count ? [DAY] : [], more: false })
      if (url === '/api/me/preferences') {
        if (refuse) return json({ detail: { code: 'bad_preference', message: 'x' } }, 422)
        return json({ ...auth.me.profile, ...body })
      }
      return json({ count: 0, days: [] })
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function show(): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => root.render(<MemoryRouter><JournalPage /></MemoryRouter>))
  await idle()
}

const pill = (name: string) => [...box.querySelectorAll<HTMLButtonElement>('[data-look-switch] button')].find((item) => item.getAttribute('aria-label') === name)!

beforeEach(async () => {
  await changeLanguage('de', false)
  auth.me = { name: 'jule', profile: { journal: 'blog', timezone: 'Europe/Berlin' } }
  count = 1
  refuse = false
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('the switch between blog and timeline', () => {
  it('shows the look in use, named for whoever cannot see the icons', async () => {
    await show()
    const group = box.querySelector('[data-look-switch]')!
    expect(group.getAttribute('aria-label')).toBe('Ansicht')
    expect(pill('Blog').getAttribute('aria-pressed')).toBe('true')
    expect(pill('Zeitleiste').getAttribute('aria-pressed')).toBe('false')
    expect(pill('Zeitleiste').getAttribute('title')).toBe('Zeitleiste')
  })

  it('switches at once, keeps the choice with the account, and shows the other look', async () => {
    await show()
    // The blog has the day as a large card, the timeline puts it under the name of its month.
    expect(box.querySelector('section h2')).toBeNull()
    await act(async () => pill('Zeitleiste').click())
    await idle()
    expect(calls.filter((call) => call.url === '/api/me/preferences').map((call) => call.body)).toEqual([{ journal: 'timeline' }])
    expect(auth.me.profile.journal).toBe('timeline')
    expect(pill('Zeitleiste').getAttribute('aria-pressed')).toBe('true')
    expect(pill('Blog').getAttribute('aria-pressed')).toBe('false')
    expect(box.textContent).toContain('Oktober 2026')
    await act(async () => pill('Blog').click())
    await idle()
    expect(auth.me.profile.journal).toBe('blog')
  })

  it('asks nothing when the look in use is pressed again', async () => {
    await show()
    await act(async () => pill('Blog').click())
    expect(calls.some((call) => call.url === '/api/me/preferences')).toBe(false)
  })

  it('puts the choice right when the server refuses it', async () => {
    refuse = true
    await show()
    await act(async () => pill('Zeitleiste').click())
    await idle()
    expect(auth.me.profile.journal).toBe('blog')
    expect(pill('Blog').getAttribute('aria-pressed')).toBe('true')
  })

  it('has no switch in a journal without a day', async () => {
    count = 0
    await show()
    expect(box.querySelector('[data-look-switch]')).toBeNull()
  })
})
