/**
 * Looking back: a week as seven tiles (the free days dashed), a month as a calendar from Monday, the tiles with the
 * value under the person's own name and the period before, the line, the best day leading to its page, the tags, the
 * arrows only as far as the server says, titles as text, and the summary only with the AI and only on a press.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import type { AiState } from '../api/client'
import type { Review, ReviewDay } from '../api/review'
import '../i18n'
import { changeLanguage } from '../i18n'
import { idle, until } from '../test/wait'
import { ReviewPage } from './ReviewPage'

const MOOD = { id: 'v1', name: 'Laune', low: 'mies', high: 'super' }
const COVER = 'illu:baum.abend.herbst'

function page(title: string) {
  return { title, cover: COVER, cover_crop: null, unreadable: false }
}

function week(change: Partial<Review> = {}): Review {
  const dates = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']
  const days: ReviewDay[] = dates.map((date) => ({ date, value: null, page: null }))
  days[0] = { date: dates[0], value: 6, page: page('Montag <img src=x onerror="window.__xss=1">') }
  days[2] = { date: dates[2], value: 9, page: page('Am See') }
  days[3] = { date: dates[3], value: 7, page: null }
  return {
    kind: 'week',
    start: '2026-09-28',
    end: '2026-10-04',
    prev: '2026-09-21',
    next: null,
    days,
    written: 2,
    total: 7,
    unreadable: 0,
    value: MOOD,
    mean: 7.333,
    mean_before: 6,
    words: 1234,
    photos: 3,
    best: { date: '2026-09-30', title: 'Am See', cover: COVER, cover_crop: null, value: 9 },
    tags: [{ tag: 'garten', count: 2 }, { tag: 'see', count: 1 }],
    ...change,
  }
}

function month(): Review {
  const days: ReviewDay[] = Array.from({ length: 30 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, '0')}`, value: null, page: null }))
  days[14] = { date: '2026-09-15', value: 8, page: page('Mitte') }
  return week({ kind: 'month', start: '2026-09-01', end: '2026-09-30', prev: null, next: '2026-10-01', days, written: 1, total: 30, mean: 8, mean_before: 5.5, best: { date: '2026-09-15', title: 'Mitte', cover: COVER, value: 8 } })
}

type Call = { method: string; url: string; body: unknown }
let calls: Call[]
let review: Review
let ai: AiState
let summary: { status: number; body: unknown }

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/ai') return json(ai)
      if (url.endsWith('/summary')) return json(summary.body, summary.status)
      if (url.startsWith('/api/review/')) return json(review)
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

function Where() {
  return <span data-where>{useLocation().pathname}</span>
}

async function show(path = '/rueckblick/woche'): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/rueckblick/:kind" element={<ReviewPage />} />
          <Route path="/rueckblick/:kind/:start" element={<ReviewPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
        <Where />
      </MemoryRouter>,
    ),
  )
  await idle()
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to click')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await idle()
}

const button = (label: string) => [...box.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
const tiles = () => [...box.querySelector('.grid-cols-2')!.children].map((tile) => tile.textContent)

beforeEach(async () => {
  await changeLanguage('de', false)
  review = week()
  ai = { provider: 'local', to: '', model: 'tiny', mine: true, allowed: true, available: true }
  summary = { status: 200, body: { text: 'Eine ruhige Woche.\n\nAm Mittwoch war ich am See.' } }
  serve()
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
  delete (window as { __xss?: number }).__xss
})

describe('a week', () => {
  it('shows seven days, the free ones dashed, and its numbers', async () => {
    await show()
    expect(calls.find((call) => call.url.startsWith('/api/review/'))!.url).toBe('/api/review/week')
    expect(box.querySelector('h1')!.textContent).toBe('Deine Woche')
    expect(box.querySelector('header p')!.textContent).toBe('28. September bis 4. Oktober')
    const strip = box.querySelector('[data-strip]')!
    expect(strip.children).toHaveLength(7)
    expect(strip.querySelectorAll('[data-free]')).toHaveLength(5)
    expect(strip.textContent).toContain('Mo 28.')
    expect(strip.textContent).toContain('frei geblieben')
    expect(tiles()).toEqual(['2von 7 Tagen geschrieben', '7,3Laune im Schnitt, Vorwoche 6,0', '1.234Wörter', '3Fotos'])
  })

  it('keeps titles as text', async () => {
    await show()
    expect(box.textContent).toContain('Montag <img src=x onerror="window.__xss=1">')
    expect((window as { __xss?: number }).__xss).toBeUndefined()
  })

  it('draws the value per day and leads to the best day', async () => {
    await show()
    const line = box.querySelector('svg[aria-label="Laune je Tag"]')!
    expect(line.querySelectorAll('circle')).toHaveLength(3)
    const best = box.querySelector<HTMLAnchorElement>('a[data-best]')!
    expect(best.getAttribute('href')).toBe('/tag/2026-09-30')
    expect(best.textContent).toContain('Bester Tag der Woche')
    expect(best.textContent).toContain('Laune 9/10')
    expect(box.textContent).toContain('Worum es ging')
    expect(box.textContent).toContain('#garten 2')
  })

  it('goes back as far as the server says, and not forward past the last week', async () => {
    await show()
    expect(button('Danach')!.hasAttribute('disabled')).toBe(true)
    review = week({ start: '2026-09-21', end: '2026-09-27', prev: null, next: '2026-09-28' })
    await click(button('Davor'))
    expect(box.querySelector('[data-where]')!.textContent).toBe('/rueckblick/woche/2026-09-21')
    expect(calls.filter((call) => call.url.startsWith('/api/review/')).at(-1)!.url).toBe('/api/review/week?start=2026-09-21')
    expect(button('Davor')!.hasAttribute('disabled')).toBe(true)
    expect(button('Danach')!.hasAttribute('disabled')).toBe(false)
  })

  it('switches between week and month', async () => {
    await show()
    review = month()
    await click(button('Monat'))
    expect(box.querySelector('[data-where]')!.textContent).toBe('/rueckblick/monat')
    expect(box.querySelector('h1')!.textContent).toBe('Dein September')
  })

  it('says so without a value and without pages', async () => {
    review = week({ value: null, mean: null, mean_before: null, best: null, written: 0, tags: [], days: week().days.map((day) => ({ ...day, page: null, value: null })) })
    await show()
    expect(tiles()[1]).toBe('keinekein Wert gefragt')
    expect(box.textContent).toContain('In dieser Woche ist keine Seite entstanden.')
    expect(box.querySelector('a[data-best]')).toBeNull()
    expect(box.querySelector('[data-summary]')).toBeNull()
  })
})

describe('a month', () => {
  it('lays the days out from Monday and compares with the month before', async () => {
    review = month()
    await show('/rueckblick/monat')
    const collage = box.querySelector('[data-collage]')!
    const cells = collage.querySelectorAll('.grid-cols-7')[1].children
    // 1 September 2026 is a Tuesday: one empty cell before it.
    expect(cells).toHaveLength(31)
    expect(cells[0].textContent).toBe('')
    expect(cells[1].textContent).toBe('1')
    expect(collage.querySelector('a[href="/tag/2026-09-15"]')).not.toBeNull()
    expect(tiles()[1]).toBe('8,0Laune im Schnitt, August 5,5')
    expect(box.textContent).toContain('Bester Tag im Monat')
  })
})

describe('the summary', () => {
  it('comes only on a press and says where the pages go', async () => {
    await show()
    const card = box.querySelector('[data-summary]')!
    expect(card.textContent).toContain('Die Woche in ein paar Sätzen')
    expect(card.textContent).toContain('Mit dem lokalen Modell eures Servers. Nichts verlässt das Haus.')
    expect(calls.some((call) => call.url.endsWith('/summary'))).toBe(false)
    await click(button('Zusammenfassen'))
    const sent = calls.find((call) => call.url.endsWith('/summary'))!
    expect(sent).toEqual({ method: 'POST', url: '/api/review/week/summary', body: { start: '2026-09-28' } })
    await until(() => card.querySelectorAll('p.font-serif, .font-serif p').length === 2)
    expect(card.textContent).toContain('Am Mittwoch war ich am See.')
    expect(button('Zusammenfassen')).toBeUndefined()
  })

  it('names the service on the internet', async () => {
    ai = { ...ai, provider: 'openai', to: 'ai.example.com' }
    await show()
    expect(box.querySelector('[data-summary]')!.textContent).toContain('Deine Seiten dieser Woche gehen dabei an ai.example.com.')
  })

  it('is not there without the AI', async () => {
    ai = { ...ai, available: false, mine: false }
    await show()
    expect(box.querySelector('[data-summary]')).toBeNull()
  })

  it('says what went wrong in its own words', async () => {
    summary = { status: 409, body: { detail: { code: 'ai_no_pages', message: 'x' } } }
    await show()
    await click(button('Zusammenfassen'))
    expect(box.querySelector('[data-summary]')!.textContent).toContain('In dieser Zeit gibt es keine Seite zum Zusammenfassen.')
    expect(button('Zusammenfassen')!.hasAttribute('disabled')).toBe(false)
  })
})
