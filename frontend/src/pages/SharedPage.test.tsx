/**
 * Shared days as the person they are shared with sees them: what the server sent and nothing else (no values, no
 * notes unless they came), hostile titles, texts, tags and names shown as text, photos only through the share, the
 * heart sent once and taken back, the day marked as opened. And the owner's list with "Teilen beenden".
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import type { SharedDay } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { SharedEntryPage, SharedPage } from './SharedPage'
import { idle } from '../test/wait'

vi.mock('../state/auth', () => ({ useAuth: () => ({ me: { profile: { timezone: 'Europe/Berlin' } } }) }))
const refresh = vi.fn()
vi.mock('../state/shared', () => ({ useShared: () => ({ unseen: 0, refresh }) }))

const HOSTILE = '<img src=x onerror="window.__xss=1">'
const DAY: SharedDay = {
  from: { id: 7, name: 'tom', display_name: `Tom ${HOSTILE}`, avatar: null },
  date: '2026-10-04',
  title: `Sonntag <script>window.__xss=2</script>`,
  text: `Am **See**.\n\n${HOSTILE}`,
  tags: ['familie', '<b onclick="window.__xss=3">x</b>'],
  cover: 'photo:' + 'a'.repeat(32),
  photos: [{ id: 'b'.repeat(32), width: 40, height: 30 }],
  with_values: false,
  with_notes: false,
  heart: null,
  shared_at: '2026-10-05T10:00:00+00:00',
}

type Call = { method: string; url: string }
let calls: Call[] = []
let answer: SharedDay | null = DAY

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/shared/7/2026-10-04' && method === 'GET') return answer ? json(answer) : json({ detail: { code: 'not_found', message: 'Not found.' } }, 404)
      if (url.endsWith('/seen')) return new Response(null, { status: 204 })
      if (url.endsWith('/heart')) return json({ heart: method === 'PUT' ? '2026-10-06T12:00:00+00:00' : null })
      if (url === '/api/shared') return json([{ from: DAY.from, date: DAY.date, title: DAY.title, excerpt: 'Am See.', cover: DAY.cover, new: true, heart: null }])
      if (url === '/api/shares') return json([{ date: '2026-10-02', title: 'Markt und Regen', cover: 'illu:regen.abend.herbst', unreadable: false, people: [{ id: 9, name: 'ruth', display_name: 'Oma Ruth', avatar: null, with_values: false, with_notes: false, heart: '2026-10-03T08:00:00+00:00' }] }])
      if (url === '/api/days/2026-10-02/shares' && method === 'DELETE') return new Response(null, { status: 204 })
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function show(path: string): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/geteilt" element={<SharedPage />} />
          <Route path="/geteilt/:from/:date" element={<SharedEntryPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await idle()
}

beforeAll(async () => {
  await changeLanguage('de')
})

beforeEach(() => {
  answer = DAY
  refresh.mockClear()
  serve()
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
  delete (window as { __xss?: number }).__xss
})

async function click(element: Element | null | undefined): Promise<void> {
  await act(async () => (element as HTMLElement).click())
  await idle()
}

describe('a day shared with me', () => {
  it('shows what came, as text, and its photos through the share only', async () => {
    await show('/geteilt/7/2026-10-04')
    expect(box.querySelector('h1')?.textContent).toBe(DAY.title)
    expect(box.textContent).toContain(`Tom ${HOSTILE}`)
    expect(box.textContent).toContain(HOSTILE)
    expect(box.textContent).toContain('#<b onclick="window.__xss=3">x</b>')
    expect(box.querySelector('strong')?.textContent).toBe('See')
    expect(box.querySelectorAll('script, b, iframe')).toHaveLength(0)
    const pictures = [...box.querySelectorAll('img')].map((image) => image.getAttribute('src'))
    expect(pictures).toEqual([`/api/shared/7/2026-10-04/photos/${'a'.repeat(32)}`, `/api/shared/7/2026-10-04/photos/${'b'.repeat(32)}`])
    expect((window as { __xss?: number }).__xss).toBeUndefined()
    // No values, no notes: the server did not send them, so nothing stands there.
    expect(box.textContent).not.toContain('Werte von dem Tag')
    expect(box.textContent).not.toContain('Notizen von dem Tag')
    // Opened: marked, and the mark in the menu asks again.
    expect(calls.some((call) => call.method === 'POST' && call.url === '/api/shared/7/2026-10-04/seen')).toBe(true)
    expect(refresh).toHaveBeenCalled()
  })

  it('shows the photos of the text inside the text, through the share, and an address of another kind never', async () => {
    const inside = 'c'.repeat(32)
    answer = { ...DAY, text: `Am See.\n\n![Der See](photo:${inside})\n\n![fremd](https://example.com/a.png)\n\n![eigen](/api/photos/${inside})` }
    await show('/geteilt/7/2026-10-04')
    const figure = box.querySelector('figure.diary-photo')!
    expect(figure.querySelector('img')?.getAttribute('src')).toBe(`/api/shared/7/2026-10-04/photos/${inside}`)
    expect(figure.querySelector('figcaption')?.textContent).toBe('Der See')
    const pictures = [...box.querySelectorAll('img')].map((image) => image.getAttribute('src') ?? '')
    expect(pictures.some((src) => src.includes('example.com') || src === `/api/photos/${inside}`)).toBe(false)
    expect(pictures.filter((src) => src.endsWith(inside))).toHaveLength(1)
    answer = DAY
  })

  it('shows values and notes when they came with it', async () => {
    answer = { ...DAY, with_values: true, with_notes: true, values: [{ name: 'Stimmung', low: 'mies', high: 'super', value: 9 }], notes: [{ text: 'see! wasser kalt', prompt: null, photo_id: 'c'.repeat(32), created_at: '2026-10-04T06:10:00+00:00' }] }
    await show('/geteilt/7/2026-10-04')
    expect(box.textContent).toContain('Stimmung')
    expect(box.textContent).toContain('see! wasser kalt')
    expect(box.textContent).toContain('08:10')
    expect([...box.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toContain(`/api/shared/7/2026-10-04/photos/${'c'.repeat(32)}/preview`)
  })

  it('sends one heart and takes it back', async () => {
    await show('/geteilt/7/2026-10-04')
    const button = () => box.querySelector('button[aria-pressed]')!
    expect(button().textContent).toContain('Herz schicken')
    await click(button())
    expect(button().getAttribute('aria-pressed')).toBe('true')
    expect(button().textContent).toContain('Herz geschickt')
    await click(button())
    expect(button().getAttribute('aria-pressed')).toBe('false')
    expect(calls.filter((call) => call.url.endsWith('/heart')).map((call) => call.method)).toEqual(['PUT', 'DELETE'])
  })

  it('says so when it is not (or no longer) shared', async () => {
    answer = null
    await show('/geteilt/7/2026-10-04')
    expect(box.textContent).toContain('Dieser Tag ist nicht (mehr) mit dir geteilt.')
    expect(calls.some((call) => call.url.endsWith('/seen'))).toBe(false)
    await act(async () => root.unmount())
    box.remove()
    await show('/geteilt/../2026-10-04')
    expect(box.textContent).toContain('Dieser Tag ist nicht (mehr) mit dir geteilt.')
  })
})

describe('the page of shared days', () => {
  it('counts the new ones in its tab and ends a share of mine', async () => {
    await show('/geteilt')
    expect(box.textContent).toContain('Mit mir geteilt (1 neu)')
    expect(box.textContent).toContain('neu')
    expect(box.querySelector('a[href="/geteilt/7/2026-10-04"]')).not.toBeNull()
    expect(box.querySelectorAll('script')).toHaveLength(0)
    await click([...box.querySelectorAll('[role=tab]')].find((tab) => tab.textContent?.includes('Von mir geteilt')))
    expect(box.textContent).toContain('Markt und Regen')
    expect(box.querySelector('[aria-label="Oma Ruth hat ein Herz geschickt"]')).not.toBeNull()
    const stop = [...box.querySelectorAll('button')].find((button) => button.textContent === 'Teilen beenden')!
    // On a phone too: nothing hides it below the width of a tablet.
    expect(stop.className.split(' ')).not.toContain('hidden')
    expect(stop.parentElement!.className.split(' ')).not.toContain('hidden')
    await click(stop)
    expect(calls.some((call) => call.method === 'DELETE' && call.url === '/api/days/2026-10-02/shares')).toBe(true)
    expect(box.textContent).toContain('Du hast noch keinen Tag geteilt.')
  })
})
