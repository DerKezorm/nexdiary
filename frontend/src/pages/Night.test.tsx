/**
 * After midnight, catching up and moving a note, on "Today" and in the quick note: the first note of a night asks which
 * day it belongs to (and waits for the answer, which goes to the server before the note does), the answer is not asked
 * again, a line says where the notes go and switches, the days with notes and no page are listed, and a note moves to
 * the day before or the day after. No test hangs on the clock: the server stand-in says what night it is.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import type { Profile } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { eventually, flush, idle, until } from '../test/wait'
import { QuickPage } from './QuickPage'
import { TodayPage } from './TodayPage'

const me: { name: string; display_name: string; profile: Profile } = {
  name: 'jule',
  display_name: 'Jule',
  profile: { palette: 'salbei', mode: 'system', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true },
}
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
/** What `/api/today` answers next. */
let today: Record<string, unknown> = {}
let nightChoice: 'yesterday' | 'today' | null = null
/** Notes that reached the server in a night nobody had answered for. */
let early: string[] = []
/** While set, the answer of `/api/night` or `/api/today` is held back until the test lets it go. */
let holdNight: Promise<void> | null = null
let holdToday: Promise<void> | null = null
/** The status `/api/today` answers with, 200 unless a test makes it fail. */
let todayStatus = 200

function gate(): { held: Promise<void>; release: () => void } {
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return { held, release }
}

const NOTE = { id: 'a0000000-0000-4000-8000-000000000001', date: '2026-10-07', text: 'kam spät heim', prompt: null, photo_id: null, created_at: '2026-10-07T00:12:00+00:00', updated_at: null, unreadable: false }

function base(date: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { date, notes: [], day: null, values: [], streak: 2, photos: [], night: { active: false }, catch_up: { count: 0, days: [] }, ...extra }
}

function night(choice: 'yesterday' | 'today' | null) {
  return { active: true, today: '2026-10-07', yesterday: '2026-10-06', choice }
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
      if (url === '/api/today') {
        await holdToday
        return todayStatus === 200 ? json(today) : json({ detail: { code: 'internal_error', message: 'x' } }, todayStatus)
      }
      if (url === '/api/night' && method === 'PUT') {
        // Held until the test lets it go: a note sent too early would get there first.
        await holdNight
        nightChoice = body!.choice as 'yesterday' | 'today'
        today = base(nightChoice === 'yesterday' ? '2026-10-06' : '2026-10-07', { night: night(nightChoice) })
        return json(night(nightChoice))
      }
      if (url === '/api/notes' && method === 'POST') {
        if (nightChoice === null && (today.night as { active: boolean }).active) early.push(String(body!.text))
        return json({ ...NOTE, id: body!.id, text: body!.text, date: nightChoice === 'yesterday' ? '2026-10-06' : '2026-10-07' }, 201)
      }
      if (url.startsWith('/api/notes/') && url.endsWith('/move')) {
        today = { ...today, notes: [] }
        return json({ ...NOTE, date: body!.direction === 'previous' ? '2026-10-06' : '2026-10-08' })
      }
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function show(page: 'today' | 'quick' = 'today'): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(<MemoryRouter>{page === 'today' ? <TodayPage now={new Date(2026, 9, 7, 0, 30)} /> : <QuickPage />}</MemoryRouter>),
  )
  await idle()
}

beforeEach(async () => {
  // jsdom lays nothing out: the quick note scrolls its list to the newest note.
  Element.prototype.scrollTo ??= () => undefined
  await changeLanguage('de', false)
  nightChoice = null
  early = []
  holdNight = null
  holdToday = null
  todayStatus = 200
  today = base('2026-10-07', { night: night(null) })
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

function type(field: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function enter(field: HTMLElement): void {
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

function field(): HTMLTextAreaElement {
  return box.querySelector<HTMLTextAreaElement>('textarea')!
}

const posts = () => calls.filter((call) => call.method === 'POST' && call.url === '/api/notes')
const dialog = () => document.querySelector('[role=dialog]')

describe('the first note of a night', () => {
  it('asks which day it belongs to, and goes out only after the answer reached the server', async () => {
    await show()
    // Nobody was asked yet: no line says where the notes go.
    expect(box.querySelector('[data-night-hint]')).toBeNull()
    type(field(), 'kam spät heim')
    await act(async () => enter(field()))
    const asked = await until(dialog, 'the question')
    expect(asked.getAttribute('aria-label')).toBe('Zu welchem Tag gehört das?')
    expect(posts()).toHaveLength(0)
    const buttons = [...asked.querySelectorAll('button:not([data-close])')].map((button) => button.textContent)
    expect(buttons).toEqual(['Zu gestern (Dienstag)', 'Zu heute (Mittwoch)'])
    // The server has not answered yet: the note must not go out while the answer is on its way.
    const answer = gate()
    holdNight = answer.held
    await act(async () => (asked.querySelectorAll('button:not([data-close])')[0] as HTMLButtonElement).click())
    await until(() => calls.some((call) => call.url === '/api/night'), 'the answer being sent')
    await flush()
    await flush()
    expect(posts()).toHaveLength(0)
    answer.release()
    await until(() => posts().length === 1, 'the note')
    await idle()
    const order = calls.filter((call) => call.url === '/api/night' || call.url === '/api/notes' || call.url === '/api/today').map((call) => `${call.method} ${call.url}`)
    expect(order.indexOf('PUT /api/night')).toBeLessThan(order.indexOf('POST /api/notes'))
    expect(calls.find((call) => call.url === '/api/night')!.body).toEqual({ choice: 'yesterday' })
    // The note names no day: the server knows the answer.
    expect(posts()).toHaveLength(1)
    expect(early).toEqual([])
    expect(posts()[0].body).not.toHaveProperty('date')
    expect(posts()[0].body!.text).toBe('kam spät heim')
    expect(dialog()).toBeNull()
    expect(field().value).toBe('')
    // The page shows the day the notes go to now, and says so.
    expect(box.textContent).toContain('Dienstag, 6. Oktober')
    expect(box.querySelector('[data-night-hint]')?.textContent).toContain('Du notierst gerade zu gestern (Dienstag).')
  })

  it('keeps the text and sends nothing when the question is put away', async () => {
    await show()
    type(field(), 'noch nicht')
    await act(async () => enter(field()))
    await until(dialog, 'the question')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    await until(() => dialog() === null, 'the question going away')
    await idle()
    expect(posts()).toHaveLength(0)
    expect(calls.some((call) => call.url === '/api/night')).toBe(false)
    expect(field().value).toBe('noch nicht')
  })

  it('does not ask again once answered, and the line switches the day for the rest of the night', async () => {
    nightChoice = 'today'
    today = base('2026-10-07', { night: night('today') })
    await show()
    const hint = box.querySelector('[data-night-hint]')!
    expect(hint.textContent).toContain('Du notierst gerade zu heute (Mittwoch).')
    type(field(), 'zweite notiz')
    await act(async () => enter(field()))
    await until(() => posts().length === 1, 'the note')
    await idle()
    expect(dialog()).toBeNull()
    const switcher = [...hint.querySelectorAll('button')].find((button) => button.textContent === 'Zu gestern wechseln')!
    await act(async () => switcher.click())
    await until(() => box.querySelector('[data-night-hint]')?.textContent?.includes('zu gestern (Dienstag)'), 'the line saying yesterday')
    expect(calls.filter((call) => call.url === '/api/night').map((call) => call.body)).toEqual([{ choice: 'yesterday' }])
  })

  it('is not asked in the daytime, and no line stands there', async () => {
    today = base('2026-10-07')
    await show()
    type(field(), 'mittags')
    await act(async () => enter(field()))
    await until(() => posts().length === 1, 'the note')
    await idle()
    expect(dialog()).toBeNull()
    expect(box.querySelector('[data-night-hint]')).toBeNull()
  })

  it('asks in the quick note too, in English as well', async () => {
    await changeLanguage('en', false)
    await show('quick')
    expect(box.querySelector('[data-night-hint]')).toBeNull()
    type(field(), 'late one')
    await act(async () => enter(field()))
    const asked = await until(dialog, 'the question')
    expect([...asked.querySelectorAll('button:not([data-close])')].map((button) => button.textContent)).toEqual(['To yesterday (Tuesday)', 'To today (Wednesday)'])
    await act(async () => (asked.querySelectorAll('button:not([data-close])')[1] as HTMLButtonElement).click())
    await until(() => posts().length === 1, 'the note')
    await until(() => box.querySelector('[data-night-hint]')?.textContent?.includes('You are noting to today (Wednesday).'), 'the line saying today')
    expect(posts()).toHaveLength(1)
  })

  it('waits for the state of the night when the note is sent before the page knows it, and then asks', async () => {
    // The answer of `/api/today` is on its way when the person has typed and pressed Enter (slow line, quick fingers).
    const loading = gate()
    holdToday = loading.held
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    box = document.createElement('div')
    document.body.appendChild(box)
    root = createRoot(box)
    await act(async () =>
      root.render(
        <MemoryRouter>
          <QuickPage />
        </MemoryRouter>,
      ),
    )
    await until(() => calls.some((call) => call.url === '/api/today'), 'the page asking for today')
    type(field(), 'zu schnell')
    await act(async () => enter(field()))
    await flush()
    await flush()
    expect(posts()).toHaveLength(0)
    expect(field().value).toBe('zu schnell')
    loading.release()
    // The state arrives: it is a night nobody was asked about, so the question comes and nothing went out before.
    const asked = await until(dialog, 'the question')
    expect(posts()).toHaveLength(0)
    expect(early).toEqual([])
    await act(async () => (asked.querySelectorAll('button:not([data-close])')[0] as HTMLButtonElement).click())
    await until(() => posts().length === 1, 'the note')
    await idle()
    expect(early).toEqual([])
    expect(posts()).toHaveLength(1)
    expect(field().value).toBe('')
  })

  it('does not send on a guess when the state of the night cannot be had, and keeps the text', async () => {
    todayStatus = 500
    await show('quick')
    type(field(), 'bleibt stehen')
    await act(async () => enter(field()))
    await eventually(() => expect(box.querySelector('[role=alert]')).not.toBeNull(), 'the problem being shown')
    await idle()
    expect(posts()).toHaveLength(0)
    expect(dialog()).toBeNull()
    expect(field().value).toBe('bleibt stehen')
  })
})

describe('days with notes and no page', () => {
  it('says how many, folded away, and lists them with a way to write each up', async () => {
    today = base('2026-10-07', {
      catch_up: {
        count: 2,
        days: [
          { date: '2026-10-05', notes: 3, start: 'Kastanien gesammelt und dann lange geredet' },
          { date: '2026-10-02', notes: 1, start: '' },
        ],
      },
    })
    await show()
    const card = box.querySelector('[data-catch-up]')!
    expect(card.textContent).toContain('2 Tage mit Notizen ohne Seite')
    expect(card.querySelector('ul')).toBeNull()
    await act(async () => (card.querySelector('button') as HTMLButtonElement).click())
    const rows = [...card.querySelectorAll('li')]
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Montag, 5. Oktober')
    expect(rows[0].textContent).toContain('3 Notizen')
    expect(rows[0].textContent).toContain('Kastanien gesammelt und dann lange geredet')
    expect(rows[1].textContent).toContain('1 Notiz')
    expect(rows.map((row) => row.querySelector('a')!.getAttribute('href'))).toEqual(['/tag/2026-10-05/schreiben', '/tag/2026-10-02/schreiben'])
  })

  it('is not there when no day is missing a page', async () => {
    await show()
    expect(box.querySelector('[data-catch-up]')).toBeNull()
  })
})

describe('moving a note', () => {
  it('moves it to the day before from its menu, takes it off the list and says where it went', async () => {
    today = base('2026-10-07', { notes: [NOTE] })
    await show()
    const more = box.querySelector<HTMLButtonElement>('button[aria-label="Mehr zur Notiz"]')!
    await act(async () => more.click())
    const items = [...box.querySelectorAll('[role=menuitem]')].map((item) => item.textContent)
    // Today is the last day a note may go to: no "next day".
    expect(items).toEqual(['Zum Vortag verschieben'])
    await act(async () => (box.querySelector('[role=menuitem]') as HTMLButtonElement).click())
    await until(() => box.textContent?.includes('Die Notiz ist zum Dienstag, 6. Oktober verschoben.'), 'the line saying where the note went')
    expect(calls.find((call) => call.url.endsWith('/move'))).toMatchObject({ method: 'POST', body: { direction: 'previous' } })
    expect(box.textContent).not.toContain('kam spät heim')
  })

  it('offers the next day for a note of an earlier day, and no menu on a locked day', async () => {
    today = base('2026-10-06', { notes: [{ ...NOTE, date: '2026-10-06' }], night: night('yesterday') })
    await show()
    await act(async () => box.querySelector<HTMLButtonElement>('button[aria-label="Mehr zur Notiz"]')!.click())
    expect([...box.querySelectorAll('[role=menuitem]')].map((item) => item.textContent)).toEqual(['Zum Vortag verschieben', 'Zum Folgetag verschieben'])
    act(() => root.unmount())
    box.remove()
    today = base('2026-10-06', { notes: [{ ...NOTE, date: '2026-10-06' }], day: { date: '2026-10-06', title: 'Zu', text: 'Ein Tag.', tags: [], values: {}, locked: true, revision: 1 } })
    await show()
    expect(box.querySelector('button[aria-label="Mehr zur Notiz"]')).toBeNull()
    expect(box.textContent).toContain('Dieser Tag ist verschlossen.')
  })
})
