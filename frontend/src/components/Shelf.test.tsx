/**
 * The shelf and the book: a volume per year as wide as it is full (a leap year counts 366 days), the open volume's
 * numbers and sentence, opening a year asks the server for that year only and again shows all, and "Als Buch" sets the
 * PDF on the server, asks how far it is, lets the browser fetch it once and says it is done; a busy server and a
 * closed dialog are dealt with.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import type { JournalDay, JournalVolume, Profile } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { JournalPage } from '../pages/JournalPage'
import { idle, until } from '../test/wait'
import { BookDialog } from './BookDialog'
import { Shelf } from './Shelf'

const me: { name: string; display_name: string; profile: Profile } = {
  name: 'jule',
  display_name: 'Jule',
  profile: { palette: 'salbei', mode: 'system', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true },
}
vi.mock('../state/auth', () => ({ useAuth: () => ({ me, setMe: () => undefined }) }))

const months = (counts: Record<number, number>) => Array.from({ length: 12 }, (_, index) => counts[index + 1] ?? 0)
const VOLUMES: JournalVolume[] = [
  { year: 2024, pages: 366, days: 366, months: months({ 1: 31, 2: 29, 3: 306 }) },
  { year: 2025, pages: 40, days: 365, months: months({ 7: 40 }) },
  { year: 2026, pages: 111, days: 365, months: months({ 9: 100, 10: 11 }) },
]

function day(date: string, title: string, excerpt = 'Kurz.'): JournalDay {
  return { date, title, excerpt, tags: [], cover: 'illu:baum.abend.herbst', written_by: 'self', first_value: { name: 'Laune', value: 7 }, shared_with: [], unreadable: false }
}

type Call = { method: string; url: string; body: unknown }
let calls: Call[]
let statuses: { state: string; pages: number; error: string | null }[]
let start: { status: number; body: unknown }

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/journal/overview') return json({ count: 517, since: '2024-01-01', tags: [], volumes: VOLUMES, year: 2026 })
      if (url === '/api/journal') {
        const year = body?.year
        const days = year === 2026 ? [day('2026-10-08', 'Neu'), day('2026-09-02', 'Lang', 'x'.repeat(250))] : [day('2026-10-08', 'Neu'), day('2025-07-01', 'Alt')]
        return json({ days, more: false })
      }
      if (url === '/api/book' && method === 'POST') return json(start.body, start.status)
      if (url.startsWith('/api/book/job1') && method === 'GET') return json({ id: 'job1', year: 2026, ...(statuses.shift() ?? { state: 'done', pages: 3, error: null }) })
      if (url.startsWith('/api/book/') && method === 'DELETE') return new Response(null, { status: 204 })
      return json(url === '/api/catch-up' ? { count: 0, days: [] } : [])
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function show(element: React.ReactNode): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => root.render(<MemoryRouter>{element}</MemoryRouter>))
  await idle()
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to click')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await idle()
}

const button = (label: string) => [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)

beforeEach(async () => {
  await changeLanguage('de', false)
  statuses = []
  start = { status: 202, body: { id: 'job1', year: 2026, state: 'working', pages: 0, error: null } }
  serve()
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the shelf', () => {
  it('has a volume per year, as wide as it is full, and an empty one for next year', async () => {
    const onYear = vi.fn()
    await show(<Shelf volumes={VOLUMES} thisYear={2026} year={null} onYear={onYear} name="Jule" />)
    const spines = [...box.querySelectorAll<HTMLElement>('[data-volume]')]
    expect(spines.map((spine) => spine.style.width)).toEqual(['76px', '35px', '44px'])
    expect(spines[0].getAttribute('aria-label')).toBe('Band 2024, 366 Seiten')
    expect(box.querySelector('[title="Band 2027 wartet"]')).not.toBeNull()
    expect(box.textContent).toContain('Band 2026')
    expect(box.textContent).toContain('111 von 365 Seiten')
    expect(box.textContent).toContain('Noch 254 Seiten frei bis Silvester. Jede Seite bleibt, auch wenn mal eine Woche fehlt.')
    await click(spines[0])
    expect(onYear).toHaveBeenCalledWith(2024)
  })

  it('counts a leap year as 366 days and calls an old volume finished', async () => {
    await show(<Shelf volumes={VOLUMES} thisYear={2026} year={2024} onYear={() => undefined} name="Jule" />)
    expect(box.textContent).toContain('366 von 366 Seiten')
    expect(box.textContent).toContain('Ein abgeschlossener Band.')
    expect(button('Nur 2024')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('opens a year in the journal on the server and shows all again', async () => {
    await show(<JournalPage />)
    const journal = () => calls.filter((call) => call.url === '/api/journal')
    expect(journal().at(-1)!.body).toEqual({ limit: 24 })
    await click(button('2026 aufschlagen'))
    expect(journal().at(-1)!.body).toEqual({ limit: 24, year: 2026 })
    expect(box.textContent).not.toContain('Alt')
    await click(button('Nur 2026'))
    expect(journal().at(-1)!.body).toEqual({ limit: 24 })
    await click(box.querySelector('[data-volume="2025"]'))
    expect(journal().at(-1)!.body).toEqual({ limit: 24, year: 2025 })
    // The shelf stands above the search and the tags.
    const shelf = box.querySelector('[data-shelf]')!
    const search = box.querySelector('input[type="search"]')!
    expect(shelf.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('the book', () => {
  const volume = VOLUMES[2]

  it('previews the year and says about how many pages it gets', async () => {
    await show(<BookDialog volume={volume} name="Jule" onClose={() => undefined} onDone={() => undefined} pollMs={5} />)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('2026 als Buch')
    expect(dialog.textContent).toContain('Das Tagebuch von Jule')
    expect(dialog.textContent).toContain('Kapitel')
    expect(dialog.textContent).toContain('September')
    expect(dialog.textContent).toContain('100 Tage')
    // Title, contents, two months, 111 days.
    expect(dialog.textContent).toContain('Etwa 115 Seiten. Das PDF entsteht auf eurem Server und geht nirgendwo hin.')
    expect(dialog.textContent).not.toContain('Laune 7/10')
    await click(button('Werte unter jedem Tag'))
    expect(dialog.textContent).toContain('Laune 7/10')
    expect(calls.find((call) => call.url === '/api/journal')!.body).toEqual({ limit: 60, year: 2026 })
  })

  it('sets the PDF on the server, waits for it and lets the browser fetch it once', async () => {
    const clicked: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this)
    })
    const onDone = vi.fn()
    statuses = [{ state: 'working', pages: 0, error: null }, { state: 'done', pages: 3, error: null }]
    await show(<BookDialog volume={volume} name="Jule" onClose={() => undefined} onDone={onDone} pollMs={5} />)
    await click(button('A4'))
    await click(button('Rohnotizen im Anhang'))
    await click(button('PDF erstellen'))
    expect(button('Wird gesetzt …')).toBeDefined()
    expect(calls.find((call) => call.url === '/api/book')!.body).toEqual({ year: 2026, format: 'a4', photos: true, values: false, notes: true })
    await until(() => onDone.mock.calls.length > 0, 'the book to be done')
    expect(onDone).toHaveBeenCalledWith('nexdiary-2026.pdf', 3)
    expect(clicked).toHaveLength(1)
    expect(clicked[0].getAttribute('href')).toBe('/api/book/job1/pdf')
    expect(clicked[0].download).toBe('nexdiary-2026.pdf')
    expect(calls.filter((call) => call.url === '/api/book/job1')).toHaveLength(2)
  })

  it('says when another book is being set', async () => {
    start = { status: 503, body: { detail: { code: 'book_busy', message: 'x' } } }
    await show(<BookDialog volume={volume} name="Jule" onClose={() => undefined} onDone={() => undefined} pollMs={5} />)
    await click(button('PDF erstellen'))
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('Gerade wird schon ein Buch gesetzt. Versuch es gleich noch einmal.')
    expect(button('PDF erstellen')!.hasAttribute('disabled')).toBe(false)
  })

  it('says why a book failed', async () => {
    statuses = [{ state: 'failed', pages: 0, error: 'book_too_long' }]
    await show(<BookDialog volume={volume} name="Jule" onClose={() => undefined} onDone={() => undefined} pollMs={5} />)
    await click(button('PDF erstellen'))
    await until(() => document.querySelector('[role="alert"]'), 'the reason')
    expect(document.querySelector('[role="alert"]')!.textContent).toBe('Das Buch hat zu lange gebraucht und wurde abgebrochen.')
  })

  it('gives the book up when the dialog closes while it is set', async () => {
    statuses = Array.from({ length: 1000 }, () => ({ state: 'working', pages: 0, error: null }))
    await show(<BookDialog volume={volume} name="Jule" onClose={() => undefined} onDone={() => undefined} pollMs={5} />)
    // Not `click`: the dialog keeps asking, so the fake API is never quiet while the book is set.
    await act(async () => button('PDF erstellen')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await until(() => calls.some((call) => call.url === '/api/book/job1'), 'the first question how far it is')
    act(() => root.unmount())
    const asked = calls.filter((call) => call.url === '/api/book/job1').length
    await until(() => calls.some((call) => call.method === 'DELETE' && call.url === '/api/book/job1'), 'the book to be given up')
    // And it stops asking.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls.filter((call) => call.method === 'GET' && call.url === '/api/book/job1').length).toBeLessThanOrEqual(asked + 1)
    root = createRoot(box)
  })

  it('opens from the shelf', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    await show(<Shelf volumes={VOLUMES} thisYear={2026} year={null} onYear={() => undefined} name="Jule" />)
    await click(button('Als Buch'))
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })
})
