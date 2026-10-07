/**
 * The writing view with pictures in the text and with a draft the morning writing made: a photo of the day, of a note, of
 * the device or of the whole collection of Immich goes into the text where the caret is (and is a photo of this day
 * then); a draft that waits is read, then accepted into the page (written with the AI) or thrown away; the whole
 * collection also serves the cover.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import '../i18n'
import { changeLanguage } from '../i18n'
import WritePage from './WritePage'

vi.mock('../state/auth', () => ({
  useAuth: () => ({ me: { name: 'jule', display_name: 'Jule', profile: { mode: 'light', layout: 'page', quick_start: false, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'manual' } } }),
}))

const DATE = '2026-10-06'
const NOTE_PHOTO = 'b'.repeat(32)
const DAY_PHOTO = 'c'.repeat(32)
const NEW_PHOTO = 'd'.repeat(32)
const ASSET = 'a1a1a1a1-0000-4000-8000-000000000001'

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let day: Record<string, unknown> | null = null
let draft: Record<string, unknown> | null = null
let photos: Record<string, unknown>[] = []
let notes: Record<string, unknown>[] = []
let immichConnected = false

const photo = (id: string, extra: Record<string, unknown> = {}) => ({ id, date: DATE, source: 'upload', width: 1200, height: 800, created_at: '2026-10-06T15:20:00+00:00', on_note: false, ...extra })

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === `/api/days/${DATE}/draft`) {
        if (method === 'DELETE') {
          draft = null
          return new Response(null, { status: 204 })
        }
        if (method === 'PUT') return json({ ...body, updated_at: '2026-10-06T17:30:00+00:00', auto: false })
        return json(draft)
      }
      if (url === `/api/days/${DATE}`) {
        if (method === 'PUT') {
          day = { date: DATE, title: '', text: '', tags: [], values: {}, cover: 'illu:baum.abend.herbst', cover_chosen: false, written_by: 'self', words: 0, created_at: '', updated_at: '', ...body, revision: 0 }
          draft = null
          return json(day)
        }
        return day ? json(day) : json({ detail: { code: 'not_found', message: 'x' } }, 404)
      }
      if (url === '/api/ai') return json({ provider: 'local', to: '', model: 'llama3.1:8b', mine: true, available: true })
      if (url.startsWith('/api/prompts/pool')) return json({ questions: [] })
      if (url.startsWith('/api/notes')) return json(notes)
      if (url.startsWith('/api/photos?') && method === 'POST') {
        const made = photo(NEW_PHOTO)
        photos = [...photos, made]
        return json(made, 201)
      }
      if (url.startsWith('/api/photos')) return json(photos)
      if (url === '/api/immich') return json(immichConnected ? { allowed: true, connected: true, url: 'http://x', key_set: true, suggest: true } : { allowed: false, connected: false })
      if (url.startsWith('/api/immich/timeline')) return json({ photos: [{ id: ASSET, taken_at: '2025-08-03T10:00:00+00:00' }], next: null })
      if (url === '/api/immich/albums') return json({ available: true, albums: [] })
      if (url.startsWith('/api/immich/photos?')) return json({ date: DATE, photos: [], more: false })
      if (url === `/api/immich/photos/${ASSET}` && method === 'POST') {
        const made = photo(NEW_PHOTO, { source: 'immich' })
        photos = [...photos, made]
        return json(made, 201)
      }
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function settle(ms = 30): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)))
}

async function show(): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[`/tag/${DATE}/schreiben`]}>
        <Routes>
          <Route path="/tag/:date/schreiben" element={<WritePage />} />
          <Route path="*" element={<p>woanders</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  for (let i = 0; i < 60 && !box.querySelector('[contenteditable=true]'); i++) await settle(20)
  await settle(40)
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button, [role=menuitem]')].find((item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

const puts = () => calls.filter((call) => call.method === 'PUT' && call.url === `/api/days/${DATE}`)

beforeAll(() => {
  const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect
  Range.prototype.getClientRects ??= (() => []) as unknown as Range['getClientRects']
  Range.prototype.getBoundingClientRect ??= empty
})

beforeEach(async () => {
  await changeLanguage('de', false)
  day = null
  draft = null
  photos = []
  notes = []
  immichConnected = false
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('pictures in the text', () => {
  it('puts a photo of the day in from the dialog and saves the line with the page', async () => {
    photos = [photo(DAY_PHOTO)]
    await show()
    await act(async () => button('Bild einfügen').click())
    await act(async () => button('Aus den Fotos dieses Tages').click())
    expect(document.querySelectorAll('[data-day-photos] button')).toHaveLength(1)
    await act(async () => document.querySelector<HTMLButtonElement>('[data-day-photos] button')!.click())
    await settle()
    expect(box.querySelectorAll('figure.diary-photo-edit img')[0].getAttribute('src')).toBe(`/api/photos/${DAY_PHOTO}`)
    await act(async () => button('Speichern').click())
    await settle(60)
    expect(puts()).toHaveLength(1)
    expect(puts()[0].body?.text).toBe(`![](photo:${DAY_PHOTO})`)
  })

  it('offers the photos of the day only when the day has some, and Immich only when it is connected', async () => {
    await show()
    await act(async () => button('Bild einfügen').click())
    expect([...document.querySelectorAll('[role=menuitem]')].map((item) => item.textContent?.trim())).toEqual(['Foto aufnehmen', 'Datei hochladen'])
  })

  it('puts the photo of a note into the text with a tap on it, and says so beside the notes', async () => {
    photos = [photo(NOTE_PHOTO, { on_note: true })]
    notes = [{ id: 'n1', date: DATE, text: 'Mit Mia im Park', prompt: null, prompt_id: null, photo_id: NOTE_PHOTO, unreadable: false, created_at: '2026-10-06T15:00:00+00:00', updated_at: null }]
    await show()
    expect(box.textContent).toContain('Antippen fügt es in den Text ein.')
    await act(async () => button('In den Text einfügen').click())
    await settle()
    expect(box.querySelectorAll('figure.diary-photo-edit')).toHaveLength(1)
    await act(async () => button('Speichern').click())
    await settle(60)
    expect(puts()[0].body?.text).toBe(`![](photo:${NOTE_PHOTO})`)
  })

  it('says nothing about tapping where no note has a photo', async () => {
    notes = [{ id: 'n1', date: DATE, text: 'Nur Worte', prompt: null, prompt_id: null, photo_id: null, unreadable: false, created_at: '2026-10-06T15:00:00+00:00', updated_at: null }]
    await show()
    expect(box.textContent).not.toContain('Antippen fügt es')
  })

  it('uploads a file of the device for this very day and puts it in', async () => {
    await show()
    const input = [...document.querySelectorAll<HTMLInputElement>('input[type=file]')].find((item) => item.getAttribute('aria-label') === 'Datei hochladen')!
    const file = new File(['x'], 'foto.jpg', { type: 'image/jpeg' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await settle(60)
    const upload = calls.find((call) => call.method === 'POST' && call.url.startsWith('/api/photos?'))!
    expect(upload.url).toContain(`date=${DATE}`)
    expect(upload.url).not.toContain('note=')
    expect(box.querySelector('figure.diary-photo-edit img')?.getAttribute('src')).toBe(`/api/photos/${NEW_PHOTO}`)
  })

  it('takes a photo of the whole collection of Immich for this day, whenever it was shot, and puts it in', async () => {
    immichConnected = true
    await show()
    await act(async () => button('Bild einfügen').click())
    await act(async () => button('Aus Immich').click())
    await settle(60)
    const tile = document.querySelector<HTMLButtonElement>('[data-immich-tiles] button:has(img)')!
    expect(tile).toBeTruthy()
    await act(async () => tile.click())
    await settle(60)
    const take = calls.find((call) => call.method === 'POST' && call.url === `/api/immich/photos/${ASSET}`)!
    expect(take.body).toEqual({ date: DATE, anywhen: true })
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(box.querySelector('figure.diary-photo-edit img')?.getAttribute('src')).toBe(`/api/photos/${NEW_PHOTO}`)
  })

  it('also lets the whole collection serve the cover of the day', async () => {
    immichConnected = true
    photos = [photo(DAY_PHOTO)]
    day = { date: DATE, title: 'Kastanien', text: 'Ein Satz.', tags: [], values: {}, cover: 'illu:baum.abend.herbst', cover_chosen: false, written_by: 'self', words: 2, revision: 0, created_at: '', updated_at: '' }
    await show()
    await act(async () => button('Titelbild ändern').click())
    await act(async () => button('Weitere aus Immich').click())
    await settle(60)
    await act(async () => document.querySelector<HTMLButtonElement>('[data-immich-tiles] button:has(img)')!.click())
    await settle(60)
    await act(async () => button('Speichern').click())
    await settle(60)
    expect(puts()[0].body?.cover).toBe(`photo:${NEW_PHOTO}`)
  })
})

describe('a draft the morning writing made', () => {
  const waiting = () => ({ title: 'Kastanien', text: 'Ich war mit Mia im Park.', tags: [], cover: null, written_by: 'ai', ai_length: 'long', base_revision: -1, updated_at: '2026-10-07T05:00:00+00:00', auto: true })

  it('is read first: it says what it is and offers to accept it or throw it away', async () => {
    draft = waiting()
    notes = [{ id: 'n1', date: DATE, text: 'Mit Mia im Park', prompt: null, prompt_id: null, photo_id: null, unreadable: false, created_at: '2026-10-06T15:00:00+00:00', updated_at: null }]
    await show()
    expect(box.textContent).toContain('Automatisch ausformuliert, wartet auf dich')
    expect(box.querySelector('[contenteditable=true]')!.textContent).toBe('Ich war mit Mia im Park.')
    expect(box.querySelector('[data-offer-ai]')).toBeNull()
    expect(box.textContent).not.toContain('Entwurf wiederhergestellt')
    expect(puts()).toHaveLength(0)
    expect(calls.some((call) => call.method === 'PUT' && call.url.endsWith('/draft'))).toBe(false)
  })

  it('becomes the page with "Abnehmen", written with the AI, and the draft is over', async () => {
    draft = waiting()
    await show()
    await act(async () => button('Abnehmen').click())
    await settle(60)
    expect(puts()).toHaveLength(1)
    expect(puts()[0].body).toMatchObject({ title: 'Kastanien', text: 'Ich war mit Mia im Park.', written_by: 'ai', base_revision: -1 })
    expect(draft).toBeNull()
    expect(box.textContent).toContain('woanders')
  })

  it('is thrown away with "Verwerfen": no page, nothing is saved, the draft is deleted', async () => {
    draft = waiting()
    await show()
    await act(async () => button('Verwerfen').click())
    await settle(60)
    expect(draft).toBeNull()
    expect(calls.some((call) => call.method === 'DELETE' && call.url === `/api/days/${DATE}/draft`)).toBe(true)
    expect(puts()).toHaveLength(0)
    expect(box.textContent).not.toContain('Automatisch ausformuliert, wartet auf dich')
    expect((box.querySelector('textarea[aria-label="Überschrift"]') as HTMLTextAreaElement).value).toBe('')
  })

  it('is an ordinary draft once it is the person’s own', async () => {
    draft = { ...waiting(), auto: false }
    await show()
    expect(box.textContent).toContain('Entwurf')
    expect(box.textContent).not.toContain('Automatisch ausformuliert, wartet auf dich')
    expect(document.querySelectorAll('[data-auto-draft]')).toHaveLength(0)
  })
})
