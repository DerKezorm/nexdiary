/**
 * Immich on "Today" and in the quick note: the block of photos shows what was uploaded lately (Immich often receives a
 * phone's photos hours late), each with the day and hour it was shot below it, and "Alle Fotos" opens the whole
 * collection; the camera button of a note offers the device or Immich where there is one, and takes a photo of Immich
 * for the note of the day, whenever it was shot.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import type { Photo, Profile } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { QuickPage } from './QuickPage'
import { TodayPage } from './TodayPage'
import { idle } from '../test/wait'

const me: { name: string; display_name: string; profile: Profile } = {
  name: 'jule',
  display_name: 'Jule',
  profile: { palette: 'salbei', mode: 'system', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true },
}
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))

const NEW1 = 'a1a1a1a1-0000-4000-8000-000000000001'
const NEW2 = 'a2a2a2a2-0000-4000-8000-000000000002'
const OLD = 'a3a3a3a3-0000-4000-8000-000000000003'
const KEPT = 'f'.repeat(32)
const photo = (extra: Partial<Photo> = {}): Photo => ({ id: KEPT, date: '2026-10-06', source: 'immich', width: 1200, height: 900, created_at: '2026-10-06T16:00:00+00:00', on_note: false, ...extra })

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let connected = true
/** The photos the server already holds for today. */
let ownPhotos: Photo[] = []
/** While set, an upload waits for it. */
let uploadGate: Promise<void> | null = null
const UPLOADED = 'e'.repeat(32)

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.startsWith('/api/today')) return json({ date: '2026-10-06', notes: [], day: null, values: [], streak: 0, photos: ownPhotos, question: null })
      if (url.startsWith('/api/photos?') && method === 'POST') {
        await uploadGate
        return json(photo({ id: UPLOADED, source: 'upload' }), 201)
      }
      if (url === '/api/ai') return json({ provider: 'none', to: '', model: '', mine: true, available: false })
      if (url === '/api/immich') return json(connected ? { allowed: true, connected: true, url: 'http://x', key_set: true, suggest: true } : { allowed: false, connected: false })
      if (url.startsWith('/api/immich/recent'))
        return json({
          date: '2026-10-06',
          more: false,
          photos: [
            { id: NEW1, taken_at: '2026-09-28T09:05:00+00:00', uploaded_at: '2026-10-06T16:00:00+00:00', photo_id: null },
            { id: NEW2, taken_at: '2026-10-06T07:30:00+00:00', uploaded_at: '2026-10-06T15:00:00+00:00', photo_id: null },
          ],
        })
      if (url.startsWith('/api/immich/timeline')) return json({ photos: [{ id: OLD, taken_at: '2024-03-02T10:00:00+00:00' }], next: null })
      if (url === '/api/immich/albums') return json({ available: true, albums: [] })
      if (url.startsWith('/api/immich/photos/') && method === 'POST') return json(photo({ on_note: Boolean(body?.note) }), 201)
      if (url === '/api/notes' && method === 'POST') return json({ id: body!.id, date: '2026-10-06', text: body!.text, prompt: null, photo_id: body!.photo_id ?? null, unreadable: false, created_at: '2026-10-06T16:30:00+00:00', updated_at: null }, 201)
      return json([])
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

const named = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button, [role=menuitem]')].find((item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)
const takes = () => calls.filter((call) => call.method === 'POST' && call.url.startsWith('/api/immich/photos/'))

beforeAll(() => {
  Element.prototype.scrollTo = vi.fn()
})

beforeEach(async () => {
  await changeLanguage('de', false)
  connected = true
  ownPhotos = []
  uploadGate = null
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('the photos of today', () => {
  it('shows what was uploaded lately, under the name "Vorschläge aus Immich", each with the day and hour it was shot', async () => {
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    expect(calls.some((call) => call.url.startsWith('/api/immich/recent?'))).toBe(true)
    expect(calls.some((call) => call.url.startsWith('/api/immich/photos?'))).toBe(false)
    expect(box.textContent).toContain('Vorschläge aus Immich')
    const shots = [...box.querySelectorAll('[data-shot]')].map((item) => item.textContent)
    expect(shots).toHaveLength(2)
    expect(shots[0]).toContain('28. Sept.')
    expect(shots[0]).toContain('11:05')
    expect(shots[1]).toContain('6. Okt.')
  })

  it('takes a photo of any day for today with a tap, and it moves up to the photos of today', async () => {
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    const tile = box.querySelector<HTMLButtonElement>('[data-photo-suggestions] button')!
    await act(async () => tile.click())
    await idle()
    expect(takes().map((call) => [call.url, call.body])).toEqual([[`/api/immich/photos/${NEW1}`, { date: '2026-10-06', anywhen: true }]])
    expect(box.querySelector(`[data-photos-today] img[src="/api/photos/${KEPT}/preview"]`)).toBeTruthy()
  })

  it('opens the whole collection with "Alle Fotos" and keeps what is taken there for today', async () => {
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    await act(async () => named('Alle Fotos')!.click())
    await idle()
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('Aus Immich wählen')
    await act(async () => document.querySelector<HTMLButtonElement>('[data-immich-tiles] button:has(img)')!.click())
    await idle()
    expect(takes().map((call) => [call.url, call.body])).toEqual([[`/api/immich/photos/${OLD}`, { date: '2026-10-06', anywhen: true }]])
    expect(document.querySelector('[role=dialog]')).toBeNull()
    expect(box.querySelector(`img[src="/api/photos/${KEPT}/preview"]`)).toBeTruthy()
  })

  it('has no "Alle Fotos" and no "Vorschläge aus Immich" without an Immich', async () => {
    connected = false
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    expect(named('Alle Fotos')).toBeUndefined()
    expect(box.textContent).not.toContain('Vorschläge aus Immich')
    expect(calls.some((call) => call.url.startsWith('/api/immich/recent'))).toBe(false)
  })
})

describe('the camera button of a note', () => {
  const camera = (label: string) => box.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!

  it('opens the device’s picker at once where there is no Immich', async () => {
    connected = false
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    expect(camera('Foto anhängen').getAttribute('aria-haspopup')).toBeNull()
    let opened = 0
    const input = box.querySelector<HTMLInputElement>('input[type=file]')!
    input.click = () => void opened++
    await act(async () => camera('Foto anhängen').click())
    expect(opened).toBe(1)
    expect(document.querySelector('[data-photo-menu]')).toBeNull()
  })

  it('offers the device and Immich where there is one', async () => {
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    await act(async () => camera('Foto anhängen').click())
    expect([...document.querySelectorAll('[data-photo-menu] [role=menuitem]')].map((item) => item.textContent?.trim())).toEqual(['Foto aufnehmen oder wählen', 'Aus Immich'])
  })

  it('takes a photo of Immich for the note of the day, whenever it was shot, and sends it with the note', async () => {
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    await act(async () => camera('Foto anhängen').click())
    await act(async () => named('Aus Immich')!.click())
    await idle()
    await act(async () => document.querySelector<HTMLButtonElement>('[data-immich-tiles] button:has(img)')!.click())
    await idle()
    expect(takes().map((call) => [call.url, call.body])).toEqual([[`/api/immich/photos/${OLD}`, { date: '2026-10-06', note: true, anywhen: true }]])
    expect(box.querySelector(`img[alt="Foto"][src="/api/photos/${KEPT}/preview"]`)).toBeTruthy()
    const field = box.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Alte Aufnahme')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => box.querySelector<HTMLButtonElement>('button[aria-label="Notieren"]')!.click())
    await idle()
    expect(calls.find((call) => call.method === 'POST' && call.url === '/api/notes')?.body).toMatchObject({ text: 'Alte Aufnahme', photo_id: KEPT })
  })

  it('does the same in the quick note', async () => {
    await show(<QuickPage />)
    await act(async () => camera('Foto aufnehmen').click())
    expect(document.querySelector('[data-photo-menu]')).toBeTruthy()
    await act(async () => named('Aus Immich')!.click())
    await idle()
    await act(async () => document.querySelector<HTMLButtonElement>('[data-immich-tiles] button:has(img)')!.click())
    await idle()
    expect(takes()[0].body).toEqual({ date: '2026-10-06', note: true, anywhen: true })
  })
})

describe('the two rows of the photos of today', () => {
  const upload = () => named('Hochladen')!
  /** Whether a part of the page can be swiped sideways: then it would carry its buttons out of sight. */
  const swipes = (item: Element) => Boolean(item.closest('.overflow-x-auto'))

  it('keeps "Hochladen" in the header, out of the rows that are swiped, with and without Immich', async () => {
    for (const withImmich of [true, false]) {
      connected = withImmich
      ownPhotos = [photo({ id: 'b'.repeat(32), source: 'upload' })]
      await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
      expect(upload()).toBeTruthy()
      expect(swipes(upload())).toBe(false)
      expect(upload().closest('[data-photo-actions]')).toBeTruthy()
      expect(Boolean(named('Alle Fotos'))).toBe(withImmich)
      if (withImmich) expect(swipes(named('Alle Fotos')!)).toBe(false)
      act(() => root.unmount())
      box.remove()
    }
  })

  it('shows the photos of the day in full colour in the first row and the suggestions muted in the second', async () => {
    ownPhotos = [photo({ id: 'b'.repeat(32), source: 'upload' })]
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    const mine = box.querySelector('[data-photos-today]')!
    const suggestions = box.querySelector('[data-photo-suggestions]')!
    expect(mine.querySelectorAll('img')).toHaveLength(1)
    expect(mine.querySelector('img')!.getAttribute('src')).toBe(`/api/photos/${'b'.repeat(32)}/preview`)
    expect(mine.querySelector('[data-shot]')).toBeNull()
    expect(suggestions.querySelectorAll('img')).toHaveLength(2)
    expect(suggestions.querySelector('img')!.className).toContain('opacity-75')
    expect(mine.contains(suggestions)).toBe(false)
    expect(box.textContent).toContain('Für heute')
    expect(box.textContent).toContain('Vorschläge aus Immich')
    expect(box.textContent).toContain('1 Foto')
  })

  it('moves a taken suggestion to the first row and brings it back when it is removed', async () => {
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    const inSuggestions = () => box.querySelectorAll('[data-photo-suggestions] img').length
    expect(inSuggestions()).toBe(2)
    await act(async () => box.querySelector<HTMLButtonElement>('[data-photo-suggestions] button')!.click())
    await idle()
    expect(inSuggestions()).toBe(1)
    expect(box.querySelectorAll('[data-photos-today] img')).toHaveLength(1)
    await act(async () => named('Foto wieder entfernen')!.click())
    await idle()
    expect(calls.some((call) => call.method === 'DELETE' && call.url === `/api/photos/${KEPT}`)).toBe(true)
    expect(inSuggestions()).toBe(2)
    expect(box.querySelector('[data-photos-today]')).toBeNull()
  })

  it('says in one sentence that there is no photo yet, instead of an empty row', async () => {
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    expect(box.querySelector('[data-photos-empty]')?.textContent).toBe('Noch kein Foto für heute. Lade eines hoch oder nimm unten einen Vorschlag.')
    expect(box.querySelector('[data-photos-today]')).toBeNull()
    act(() => root.unmount())
    box.remove()
    connected = false
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    expect(box.querySelector('[data-photos-empty]')?.textContent).toBe('Noch kein Foto für heute.')
    expect(box.querySelector('[data-photo-suggestions]')).toBeNull()
  })

  it('shows the upload while it runs and puts the new photo in the first row', async () => {
    connected = false
    let finish!: () => void
    uploadGate = new Promise<void>((resolve) => (finish = resolve))
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    const input = box.querySelector<HTMLInputElement>('input[type=file][aria-label="Hochladen"]')!
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.jpg', { type: 'image/jpeg' })], configurable: true })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(named('Wird hochgeladen …')?.disabled).toBe(true)
    expect(box.querySelector('[data-photos-today]')).toBeNull()
    finish()
    await idle()
    expect(upload().disabled).toBe(false)
    expect(box.querySelector(`[data-photos-today] img[src="/api/photos/${UPLOADED}/preview"]`)).toBeTruthy()
  })
})
