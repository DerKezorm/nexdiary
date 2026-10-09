/**
 * The reading page of a day, two parts added after the walk through with the family: the family question of that date
 * (shown only when the server gives it, which it does only to whoever answered then), and deleting the page (asked
 * first, saying what stays and who loses the share; back to "Today" for today, the day itself for another).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import '../i18n'
import { changeLanguage } from '../i18n'
import { EntryPage } from './EntryPage'
import { idle } from '../test/wait'

vi.mock('../state/auth', () => ({
  useAuth: () => ({ me: { id: 1, name: 'jule', display_name: 'Jule', sign_in: 'password', profile: { mode: 'light', layout: 'page', journal: 'blog', timezone: 'Europe/Berlin' } } }),
}))

const DATE = '2026-10-06'
type Call = { method: string; url: string }
let calls: Call[] = []
let day: Record<string, unknown> | null = null
let family: unknown = null
let shared: Record<string, unknown>[] = []
let todayDate = '2026-10-09'

function page(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { date: DATE, title: 'Kastanien', text: 'Ein langer Tag.', tags: [], values: {}, cover: 'illu:baum.abend.herbst', cover_chosen: false, written_by: 'self', words: 3, revision: 2, locked: false, locked_at: null, created_at: '', updated_at: '', ...extra }
}

const CARD = {
  date: DATE,
  question: { id: 'familie.4', text: 'Was war heute dein schönster Moment?' },
  people: [
    { id: 1, name: 'jule', display_name: 'Jule', avatar: null, me: true, answered: true },
    { id: 2, name: 'tom', display_name: 'Tom', avatar: null, me: false, answered: true },
  ],
  mine: { text: 'Kastanien sammeln.', at: '2026-10-06T17:00:00+00:00' },
  answers: [{ from: 2, text: 'Die Suppe am Abend.', at: '2026-10-06T16:00:00+00:00' }],
}

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === `/api/family/day/${DATE}`) return json(family)
      if (url === `/api/days/${DATE}` && method === 'DELETE') {
        day = null
        return new Response(null, { status: 204 })
      }
      if (url === `/api/days/${DATE}`) return day ? json(day) : json({ detail: { code: 'not_found', message: 'x' } }, 404)
      if (url === `/api/days/${DATE}/shares`) return json({ date: DATE, people: shared, with_values: false, with_notes: false })
      if (url === '/api/today') return json({ date: todayDate, notes: [], day: null, values: [], streak: 0, photos: [] })
      if (url === '/api/journal' && method === 'POST') return json({ days: [], more: false })
      return json([])
    }),
  )
}

function Landed() {
  const location = useLocation()
  return <p data-landed={location.pathname}>{JSON.stringify(location.state)}</p>
}

let root: Root
let box: HTMLDivElement

async function entry(): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[`/tag/${DATE}`]}>
        <Routes>
          <Route path="/tag/:date" element={<EntryPage />} />
          <Route path="/" element={<Landed />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await idle()
}

function button(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)
}

beforeEach(async () => {
  await changeLanguage('de', false)
  day = page()
  family = null
  shared = []
  todayDate = '2026-10-09'
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('the family question of the day', () => {
  it('shows the question and the answers of that date as bubbles, below the day', async () => {
    family = CARD
    await entry()
    const card = box.querySelector('[data-family-day]')!
    expect(card.querySelector('[data-family-question]')!.textContent).toBe('Was war heute dein schönster Moment?')
    expect(card.querySelector('[data-answers]')!.textContent).toContain('TomDie Suppe am Abend.')
    expect(card.querySelector('[data-mine] p')!.textContent).toBe('Kastanien sammeln.')
    // No field and nothing to change: it is read again, not answered.
    expect(card.querySelector('textarea')).toBeNull()
    expect(box.querySelector('article')!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(calls.filter((call) => call.url === `/api/family/day/${DATE}`)).toHaveLength(1)
  })

  it('shows nothing at all when the server gives nothing (not answered then)', async () => {
    await entry()
    expect(box.querySelector('[data-family-day]')).toBeNull()
    expect(box.textContent).not.toContain('Familienfrage')
  })

  it('shows it also on a day without a page', async () => {
    day = null
    family = CARD
    await entry()
    expect(box.textContent).toContain('Diesen Tag gibt es nicht.')
    expect(box.querySelector('[data-family-day]')).not.toBeNull()
  })
})

describe('deleting the page', () => {
  it('asks first, names who loses the share, and stays on the day, which is gone then', async () => {
    shared = [
      { id: 2, name: 'tom', display_name: 'Tom', avatar: null, with_values: false, with_notes: false, heart: null },
      { id: 3, name: 'ruth', display_name: 'Oma Ruth', avatar: null, with_values: false, with_notes: false, heart: null },
    ]
    await entry()
    await act(async () => button('Seite löschen')!.click())
    await idle()
    const dialog = document.querySelector('[role=dialog]')!
    expect(dialog.textContent).toContain('Titel, Text, Tags und Werte dieses Tages gehen verloren.')
    expect(dialog.querySelector('[data-delete-shared]')!.textContent).toBe('Geteilt ist der Tag dann nicht mehr: Tom und Oma Ruth sehen ihn nicht mehr.')
    await act(async () => button('Abbrechen')!.click())
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    await act(async () => button('Seite löschen')!.click())
    await act(async () => button('Löschen')!.click())
    await idle()
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.url)).toEqual([`/api/days/${DATE}`])
    expect(box.textContent).toContain('Diesen Tag gibt es nicht.')
  })

  it('leads back to "Today" when the page of today was deleted', async () => {
    todayDate = DATE
    await entry()
    await act(async () => button('Seite löschen')!.click())
    await idle()
    expect(document.querySelector('[data-delete-shared]')).toBeNull()
    await act(async () => button('Löschen')!.click())
    await idle()
    expect(box.querySelector('[data-landed]')!.getAttribute('data-landed')).toBe('/')
    expect(box.querySelector('[data-landed]')!.textContent).toBe('{"notice":"Seite gelöscht. Deine Notizen sind noch da."}')
  })

  it('is not offered for a locked day', async () => {
    day = page({ locked: true, locked_at: '2026-10-07T10:00:00+00:00' })
    await entry()
    expect(button('Seite löschen')).toBeUndefined()
  })
})
