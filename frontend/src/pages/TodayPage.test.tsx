/**
 * "Today": the greeting by the hour (the hour comes from outside, no test hangs on the clock), the day as the server
 * names it, the three layouts, a note sent twice by a double Enter going out once, and a rating taken back.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import type { Profile } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { greetingOf, TodayPage } from './TodayPage'

const me: { name: string; display_name: string; profile: Profile } = {
  name: 'jule',
  display_name: 'Jule',
  profile: { mode: 'system', layout: 'page', quick_start: true, timezone: 'Europe/Berlin', timezone_source: 'browser' },
}
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))

const TODAY = {
  date: '2026-10-06',
  notes: [
    { id: 'a0000000-0000-4000-8000-000000000001', date: '2026-10-06', text: 'schlecht geschlafen', prompt: null, photo_id: null, created_at: '2026-10-06T05:12:00+00:00', updated_at: null },
    { id: 'a0000000-0000-4000-8000-000000000002', date: '2026-10-06', text: 'kastanien gesammelt', prompt: null, photo_id: null, created_at: '2026-10-06T16:50:00+00:00', updated_at: null },
  ],
  day: null,
  values: [{ id: 'v1', name: 'Stimmung', low: 'mies', high: 'super', hint: 'Wie ging es dir heute?', active: true, position: 0 }],
  streak: 4,
}

type Call = { method: string; url: string; body: unknown }
let calls: Call[] = []
let failNext = false
/** The server keeps the note but the answer never arrives (a dropped connection). */
let loseNext = false
/** What the server holds by note id, to answer like it does (same text: the note; other text: 409). */
let held = new Map<string, string>()

function serve(): void {
  calls = []
  held = new Map()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.startsWith('/api/today')) return json(TODAY)
      if (url === '/api/notes' && method === 'POST') {
        // Slow enough that a second Enter arrives while the first is on its way.
        await new Promise((resolve) => setTimeout(resolve, 20))
        if (failNext) {
          failNext = false
          return new Response('{}', { status: 503 })
        }
        const before = held.get(body.id)
        if (before !== undefined && before !== body.text) return json({ detail: { code: 'note_id_taken', message: 'x' } }, 409)
        held.set(body.id, body.text)
        if (loseNext) {
          loseNext = false
          throw new TypeError('connection dropped')
        }
        return json({ ...TODAY.notes[0], id: body.id, text: body.text, unreadable: false, created_at: '2026-10-06T17:00:00+00:00' }, 201)
      }
      if (url.includes('/values')) return json({ date: '2026-10-06', title: '', text: '', tags: [], values: body.values.v1 ? { v1: body.values.v1 } : {}, cover: null, written_by: null, words: 0, created_at: '', updated_at: '' })
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function show(layout: Profile['layout']): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  me.profile = { ...me.profile, layout }
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter>
        <TodayPage now={new Date(2026, 9, 6, 19, 30)} />
      </MemoryRouter>,
    ),
  )
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

beforeEach(async () => {
  await changeLanguage('de', false)
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

function typeAndEnter(field: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function enter(field: HTMLTextAreaElement): void {
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

describe('the greeting', () => {
  it('is the morning until eleven, the day until six, then the evening', () => {
    expect([0, 10, 11, 17, 18, 23].map(greetingOf)).toEqual(['morning', 'morning', 'day', 'day', 'evening', 'evening'])
  })

  it('names the day the server calls today, and the person', async () => {
    await show('page')
    expect(box.querySelector('header p')!.textContent).toBe('Dienstag, 6. Oktober')
    expect(box.querySelector('h1')!.textContent).toBe('Guten Abend, Jule')
    expect(box.textContent).toContain('4')
  })
})

describe('today', () => {
  it.each(['page', 'columns', 'chat'] as const)('shows the notes of the day in the layout %s', async (layout) => {
    await show(layout)
    expect(box.textContent).toContain('schlecht geschlafen')
    expect(box.textContent).toContain('kastanien gesammelt')
    // The time in the person's zone: 05:12 UTC is 07:12 in Berlin.
    expect(box.textContent).toContain('07:12')
    const yourDay = [...box.querySelectorAll('button')].some((button) => button.textContent === 'Dein Tag')
    expect(yourDay).toBe(layout === 'chat')
    if (layout !== 'chat') expect(box.textContent).toContain('Wie war dein Tag?')
  })

  it('sends a note once when Enter comes twice, and keeps the text when the server is away', async () => {
    await show('page')
    const field = box.querySelector('textarea')!
    typeAndEnter(field, 'mittag im park')
    await act(async () => {
      enter(field)
      enter(field)
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(1)
    expect(field.value).toBe('')
    expect(box.textContent).toContain('mittag im park')

    failNext = true
    typeAndEnter(field, 'zweiter versuch')
    await act(async () => {
      enter(field)
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    expect(field.value).toBe('zweiter versuch')
    await act(async () => {
      enter(field)
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    const tries = calls.filter((call) => call.method === 'POST').slice(1).map((call) => (call.body as { id: string }).id)
    expect(tries).toHaveLength(2)
    expect(tries[0]).toBe(tries[1])
    expect(tries[0]).not.toBe((posts[0].body as { id: string }).id)
  })

  it('sends a text changed after a lost answer under a new id, so it is not taken for the old note', async () => {
    await show('page')
    const field = box.querySelector('textarea')!
    loseNext = true
    typeAndEnter(field, 'erste fassung')
    await act(async () => {
      enter(field)
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    expect(field.value).toBe('erste fassung')
    typeAndEnter(field, 'erste fassung, ergänzt')
    await act(async () => {
      enter(field)
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    const ids = calls.filter((call) => call.method === 'POST').map((call) => (call.body as { id: string }).id)
    expect(ids).toHaveLength(2)
    expect(ids[1]).not.toBe(ids[0])
    expect(field.value).toBe('')
    expect([...held.values()]).toEqual(['erste fassung', 'erste fassung, ergänzt'])
  })

  it('keeps a text whose id was taken: it goes out again under a new id', async () => {
    await show('page')
    const field = box.querySelector('textarea')!
    loseNext = true
    typeAndEnter(field, 'alt')
    await act(async () => {
      enter(field)
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    // The id of the lost send now holds "alt"; force the same id for another text, as an older client would.
    const first = (calls[calls.length - 1].body as { id: string }).id
    held.set(first, 'etwas anderes')
    typeAndEnter(field, 'alt')
    await act(async () => {
      enter(field)
      await new Promise((resolve) => setTimeout(resolve, 80))
    })
    const posts = calls.filter((call) => call.method === 'POST').map((call) => call.body as { id: string; text: string })
    expect(posts.map((post) => post.text)).toEqual(['alt', 'alt', 'alt'])
    expect(posts[1].id).toBe(first)
    expect(posts[2].id).not.toBe(first)
    expect(field.value).toBe('')
  })

  it('rates a value and takes the rating back with a second tap', async () => {
    await show('page')
    const six = box.querySelector<HTMLButtonElement>('button[aria-label="6 von 10"]')!
    await act(async () => six.click())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(six.getAttribute('aria-pressed')).toBe('true')
    await act(async () => six.click())
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const ratings = calls.filter((call) => call.url.endsWith('/values')).map((call) => call.body)
    expect(ratings).toEqual([{ values: { v1: 6 } }, { values: { v1: null } }])
    expect(six.getAttribute('aria-pressed')).toBe('false')
  })
})
