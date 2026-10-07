/**
 * Writing a day up against a server stand-in: the page loads with its revision, a double click saves once, only what
 * was changed here is sent, the draft goes out while typing, when the page is left and when it is hidden, a field
 * changed meanwhile elsewhere is never overwritten unseen (the other version stands there to copy from), and a photo
 * can be deleted from the cover picker.
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'

import '../i18n'
import { changeLanguage } from '../i18n'
import WritePage from './WritePage'

vi.mock('../state/auth', () => ({
  useAuth: () => ({ me: { name: 'jule', display_name: 'Jule', profile: { mode: 'light', layout: 'page', quick_start: false, timezone: 'Europe/Berlin', timezone_source: 'manual' } } }),
}))

const DATE = '2026-10-06'
const PHOTO = 'c'.repeat(32)
type Day = Record<string, unknown> & { revision: number; title: string; text: string; tags: string[] }
type Call = { method: string; url: string; body: Record<string, unknown> | undefined; keepalive: boolean }

let calls: Call[] = []
let day: Day | null = null
let draft: Record<string, unknown> | null = null
let photos: Record<string, unknown>[] = []
/** What the next save meets: another device's page that came in between. */
let meanwhile: Day | null = null

function page(fields: Partial<Day>): Day {
  return { date: DATE, title: '', text: '', tags: [], values: {}, cover: 'illu:baum.abend.herbst', cover_chosen: false, written_by: 'self', words: 0, revision: 0, created_at: '', updated_at: '2026-10-06T17:00:00+00:00', ...fields }
}

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body, keepalive: Boolean(init?.keepalive) })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === `/api/days/${DATE}/draft`) {
        if (method === 'PUT') {
          draft = { ...body, updated_at: '2026-10-06T17:30:00+00:00' }
          return json(draft)
        }
        if (method === 'DELETE') {
          draft = null
          return new Response(null, { status: 204 })
        }
        return json(draft)
      }
      if (url === `/api/days/${DATE}`) {
        if (method === 'PUT') {
          await new Promise((resolve) => setTimeout(resolve, 20))
          if (meanwhile) {
            day = meanwhile
            meanwhile = null
          }
          const standing = day ? day.revision : -1
          if (body!.base_revision !== standing) return json({ detail: { code: 'day_changed', message: 'x', revision: standing } }, 409)
          const { base_revision: _base, ...fields } = body!
          day = page({ ...(day ?? {}), ...fields, revision: standing + 1, cover_chosen: 'cover' in fields || Boolean(day?.cover_chosen) })
          draft = null
          return json(day)
        }
        return day ? json(day) : json({ detail: { code: 'not_found', message: 'x' } }, 404)
      }
      if (url.startsWith('/api/photos/') && method === 'DELETE') {
        photos = photos.filter((photo) => !url.endsWith(String(photo.id)))
        return new Response(null, { status: 204 })
      }
      if (url.startsWith('/api/notes')) return json([])
      if (url.startsWith('/api/photos')) return json(photos)
      if (url.startsWith('/api/today')) return json({ date: DATE, notes: [], day, values: [], streak: 5, photos: [] })
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement
const away = { leave: () => undefined as void }

async function settle(ms = 30): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)))
}

/** Leaves the writing page within the app, as a link or the back button would. */
function Away() {
  const navigate = useNavigate()
  useEffect(() => {
    away.leave = () => void navigate('/woanders')
  })
  return null
}

async function show(): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[`/tag/${DATE}/schreiben`]}>
        <Away />
        <Routes>
          <Route path="/tag/:date/schreiben" element={<WritePage />} />
          <Route path="*" element={<p>woanders</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  for (let i = 0; i < 50 && !box.querySelector('[contenteditable]'); i++) await settle(20)
  await settle(20)
}

function title(): HTMLInputElement {
  return box.querySelector<HTMLInputElement>('input[aria-label="Überschrift"]')!
}

function type(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Text typed into the editor, the way the browser puts it into the page (ProseMirror reads it from there). */
async function typeInEditor(text: string): Promise<void> {
  const paragraph = box.querySelector('[contenteditable] p')!
  await act(async () => {
    if (paragraph.firstChild && paragraph.firstChild.nodeType === Node.TEXT_NODE) paragraph.firstChild.textContent = text
    else paragraph.replaceChildren(document.createTextNode(text))
    await Promise.resolve()
  })
}

function button(text: string): HTMLButtonElement {
  return [...box.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)!
}

function saveButtons(): HTMLButtonElement[] {
  return [...box.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent?.includes('Speichern') && !item.textContent.includes('Fassung'))
}

const puts = () => calls.filter((call) => call.method === 'PUT' && call.url === `/api/days/${DATE}`)
const drafts = () => calls.filter((call) => call.method === 'PUT' && call.url.endsWith('/draft'))

beforeEach(async () => {
  await changeLanguage('de', false)
  day = null
  draft = null
  meanwhile = null
  photos = []
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('writing a day up', () => {
  it('opens the page of the day and saves it once, however often Save is clicked, with only what changed', async () => {
    day = page({ title: 'Kastanien', text: 'Die Nacht war kurz.', tags: ['herbst'], revision: 3 })
    await show()
    expect(title().value).toBe('Kastanien')
    expect(box.querySelector('[contenteditable]')!.textContent).toBe('Die Nacht war kurz.')
    type(title(), 'Kastanien im Park')
    const [first] = saveButtons()
    await act(async () => {
      first.click()
      first.click()
      saveButtons()[1].click()
    })
    await settle(80)
    expect(puts()).toHaveLength(1)
    // The title changed here; the cover goes along while none was chosen (a page always has one); nothing else.
    expect(puts()[0].body).toEqual({ title: 'Kastanien im Park', cover: 'illu:baum.abend.herbst', base_revision: 3 })
    expect(box.textContent).toContain('woanders')
  })

  it('makes a new page savable with its first letter, at once', async () => {
    await show()
    expect(saveButtons()[0].disabled).toBe(true)
    await typeInEditor('E')
    expect(saveButtons()[0].disabled).toBe(false)
    await act(async () => saveButtons()[0].click())
    await settle(80)
    expect(puts()[0].body).toEqual({ text: 'E', cover: 'illu:baum.abend.herbst', written_by: 'self', base_revision: -1 })
  })

  it('keeps a draft while typing and brings it back when the page opens again', async () => {
    await show()
    type(title(), 'Halb fertig')
    await settle(1700)
    expect(drafts()).toHaveLength(1)
    expect(drafts()[0].body).toEqual({ title: 'Halb fertig', text: '', tags: [], cover: null, base_revision: -1 })
    expect(box.textContent).toContain('Entwurf gesichert')
    act(() => root.unmount())
    box.remove()
    await show()
    expect(title().value).toBe('Halb fertig')
    expect(box.textContent).toMatch(/Dein Entwurf von \d\d:\d\d ist wieder da\./)
  })

  it('sends the draft when the page is left, before the pause in typing is over', async () => {
    await show()
    type(title(), 'Gleich weg')
    await act(async () => away.leave())
    await settle(30)
    expect(box.textContent).toContain('woanders')
    expect(drafts().map((call) => call.body!.title)).toEqual(['Gleich weg'])
    expect(drafts()[0].keepalive).toBe(false)
  })

  it('sends a draft with a hidden page by keepalive while it is small, as an ordinary request when it is large', async () => {
    await show()
    const hide = async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      await settle(30)
    }
    type(title(), 'Klein')
    await hide()
    type(title(), 'G'.repeat(70_000).slice(0, 200))
    await typeInEditor('x'.repeat(70_000))
    await hide()
    expect(drafts().map((call) => call.keepalive)).toEqual([true, false])
  })

  it('does not overwrite a field changed meanwhile on another device; the other version stands there to copy', async () => {
    day = page({ title: 'Morgens', text: 'Vom Laptop.', revision: 0 })
    await show()
    meanwhile = page({ title: 'Von dort', text: 'Vom Handy, später.', revision: 1 })
    type(title(), 'Abends')
    await act(async () => saveButtons()[0].click())
    await settle(80)
    expect(box.textContent).toContain('Dieser Tag wurde inzwischen auf einem anderen Gerät geändert.')
    expect(box.querySelector('[data-other-version]')!.textContent).toBe('Von dort\n\nVom Handy, später.')
    expect(day!.title).toBe('Von dort')
    await act(async () => button('Meine Fassung speichern').click())
    await settle(80)
    expect(puts().map((call) => call.body!.base_revision)).toEqual([0, 1])
    // Only the title was changed here: the text from the other device stays.
    expect(day!.title).toBe('Abends')
    expect(day!.text).toBe('Vom Handy, später.')
  })

  it('loads the other version instead, when asked', async () => {
    day = page({ title: 'Morgens', text: 'Vom Laptop.', revision: 0 })
    await show()
    meanwhile = page({ title: 'Von dort', text: 'Vom Handy, später.', revision: 1 })
    type(title(), 'Abends')
    await act(async () => saveButtons()[0].click())
    await settle(80)
    await act(async () => button('Die andere Fassung laden').click())
    await settle(80)
    expect(title().value).toBe('Von dort')
    expect(box.querySelector('[contenteditable]')!.textContent).toBe('Vom Handy, später.')
    expect(puts()).toHaveLength(1)
  })

  it('keeps tags set meanwhile elsewhere when only the title changed here', async () => {
    day = page({ title: 'Morgens', text: 'Vom Laptop.', tags: ['herbst'], revision: 0 })
    await show()
    // Tags and a rating on "Today" in another tab: the revision moves on, title and text stay.
    meanwhile = page({ title: 'Morgens', text: 'Vom Laptop.', tags: ['herbst', 'familie'], values: { v1: 7 }, revision: 1 })
    type(title(), 'Abends')
    await act(async () => saveButtons()[0].click())
    await settle(150)
    expect(box.textContent).not.toContain('Dieser Tag wurde inzwischen')
    expect(puts().map((call) => call.body!.base_revision)).toEqual([0, 1])
    expect(puts()[1].body).not.toHaveProperty('tags')
    expect(day!.title).toBe('Abends')
    expect(day!.tags).toEqual(['herbst', 'familie'])
  })

  it('saves the last words typed, even when Save comes right after them', async () => {
    day = page({ title: 'Kastanien', text: 'Die Nacht war kurz.', revision: 0 })
    await show()
    await typeInEditor('Die Nacht war kurz. Gerade getippt.')
    await act(async () => saveButtons()[0].click())
    await settle(80)
    expect(puts()[0].body!.text).toBe('Die Nacht war kurz. Gerade getippt.')
  })

  it('deletes an own photo from the cover picker after asking, and falls back to the suggestion', async () => {
    photos = [{ id: PHOTO, date: DATE, source: 'upload', width: 10, height: 10, created_at: '2026-10-06T17:00:00+00:00' }]
    day = page({ title: 'Mit Foto', text: 'Text.', cover: `photo:${PHOTO}`, cover_chosen: true, revision: 0 })
    await show()
    expect(box.querySelector('article img')!.getAttribute('src')).toBe(`/api/photos/${PHOTO}`)
    await act(async () => button('Titelbild ändern').click())
    await act(async () => button('Foto löschen').click())
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    expect(box.textContent).toContain('Foto löschen?')
    await act(async () => button('Löschen').click())
    await settle(30)
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.url)).toEqual([`/api/photos/${PHOTO}`])
    expect(box.querySelector(`img[src^="/api/photos/${PHOTO}"]`)).toBeNull()
    await act(async () => button('Schließen').click())
    expect(box.querySelector('article svg[role=img]')).not.toBeNull()
  })
})
