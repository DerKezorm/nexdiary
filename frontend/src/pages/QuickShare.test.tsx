/**
 * Photos shared from another app, in the quick note: the share the service worker kept (`?geteilt=<id>`) is taken out
 * of the browser's storage once, each photo goes up the ordinary way (the upload of a note, with the tab's header) and
 * becomes a note of its own, the text in the first. Ten at most; a photo the server refuses is said as on any upload;
 * after midnight the question "which day?" comes first; and what did not arrive is said honestly. Nothing of a share
 * stays in the storage afterwards.
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import type { Profile } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { FakeCacheStorage, keepShare } from '../test/fakeCaches'
import { idle, until } from '../test/wait'
import { QuickPage } from './QuickPage'

const me: { name: string; display_name: string; profile: Profile } = {
  name: 'jule',
  display_name: 'Jule',
  profile: { palette: 'salbei', mode: 'system', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true },
}
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))

type Call = { method: string; url: string; body: unknown; client: string | undefined }
let calls: Call[] = []
let today: Record<string, unknown> = {}
let nightChoice: 'yesterday' | 'today' | null = null
let made = 0

function base(date: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { date, notes: [], day: null, values: [], streak: 2, photos: [], night: { active: false }, catch_up: { count: 0, days: [] }, ...extra }
}

function night(choice: 'yesterday' | 'today' | null) {
  return { active: true, today: '2026-10-10', yesterday: '2026-10-09', choice }
}

function serve(): void {
  calls = []
  made = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const raw = init?.body
      const body = typeof raw === 'string' ? JSON.parse(raw) : raw
      calls.push({ method, url, body, client: (init?.headers as Record<string, string> | undefined)?.['X-Nexdiary-Client'] })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      const day = nightChoice === 'yesterday' ? '2026-10-09' : '2026-10-10'
      if (url === '/api/today') return json(today)
      if (url === '/api/night' && method === 'PUT') {
        nightChoice = (body as { choice: 'yesterday' | 'today' }).choice
        today = base(nightChoice === 'yesterday' ? '2026-10-09' : '2026-10-10', { night: night(nightChoice) })
        return json(night(nightChoice))
      }
      if (url.startsWith('/api/photos?') && method === 'POST') {
        const picture = raw as Blob
        if (picture.type !== 'image/jpeg') return json({ detail: { code: 'photo_not_a_picture', message: 'x' } }, 422)
        if (picture.size > 1000) return json({ detail: { code: 'photo_too_large', message: 'x', max_mb: 20 } }, 422)
        made += 1
        return json({ id: `${String(made).padStart(2, '0')}${'f'.repeat(30)}`, date: day, source: 'upload', width: 4, height: 3, created_at: '2026-10-10T09:00:00+00:00', on_note: true }, 201)
      }
      if (url === '/api/notes' && method === 'POST') {
        const sent = body as { id: string; text: string; photo_id: string | null }
        return json({ id: sent.id, date: day, text: sent.text, prompt: null, photo_id: sent.photo_id, created_at: '2026-10-10T09:00:00+00:00', updated_at: null, unreadable: false }, 201)
      }
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement
let storage: FakeCacheStorage
let address = ''

function Where() {
  const location = useLocation()
  useEffect(() => {
    address = location.pathname + location.search
  }, [location])
  return null
}

async function show(entry: string): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/schnell"
            element={
              <>
                <QuickPage />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await idle()
}

let counter = 0
/** A fresh id for each share: the page remembers which shares it took in already. */
function newShareId(): string {
  counter += 1
  return `5ba7e000-0000-4000-8000-${String(counter).padStart(12, '0')}`
}

function picture(size = 100, type = 'image/jpeg'): Blob {
  return new Blob([new Uint8Array(size).fill(1)], { type })
}

beforeEach(async () => {
  Element.prototype.scrollTo ??= () => undefined
  await changeLanguage('de', false)
  nightChoice = null
  today = base('2026-10-10')
  storage = new FakeCacheStorage(window.location.origin)
  vi.stubGlobal('caches', storage)
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

const uploads = () => calls.filter((call) => call.method === 'POST' && call.url.startsWith('/api/photos?'))
const notes = () => calls.filter((call) => call.method === 'POST' && call.url === '/api/notes').map((call) => call.body as { text: string; photo_id: string | null })
const alerts = () => [...box.querySelectorAll('[role=alert]')].map((item) => item.textContent)
const field = () => box.querySelector<HTMLTextAreaElement>('textarea')!
const dialog = () => document.querySelector('[role=dialog]')

describe('photos shared into the quick note', () => {
  it('make one note each, the text in the first, uploaded the ordinary way, and leave nothing behind', async () => {
    const id = newShareId()
    await keepShare(storage, id, Date.now(), [picture(10), picture(20), picture(30)], { text: 'Kastanien im Park' })
    await show(`/schnell?geteilt=${id}`)
    await until(() => notes().length === 3, 'three notes')
    await idle()
    expect(uploads()).toHaveLength(3)
    expect(uploads().map((call) => (call.body as Blob).size)).toEqual([10, 20, 30])
    for (const call of uploads()) {
      const query = new URL(call.url, window.location.origin).searchParams
      // For a note, on the server's own day (no date), each with an id of its own against a lost answer.
      expect(query.get('note')).toBe('true')
      expect(query.has('date')).toBe(false)
      expect(query.get('upload_id')).toMatch(/^[0-9a-f-]{32,36}$/)
      expect(call.client).toBeTruthy()
    }
    expect(new Set(uploads().map((call) => new URL(call.url, window.location.origin).searchParams.get('upload_id'))).size).toBe(3)
    expect(notes().map((note) => [note.text, note.photo_id])).toEqual([
      ['Kastanien im Park', `01${'f'.repeat(30)}`],
      ['', `02${'f'.repeat(30)}`],
      ['', `03${'f'.repeat(30)}`],
    ])
    expect(storage.addresses()).toEqual([])
    expect(address).toBe('/schnell')
    expect(alerts()).toEqual([])
    expect(field().value).toBe('')
    // The notes join the list as they come; the day is not loaded anew for each.
    expect(box.querySelectorAll('ol li')).toHaveLength(3)
    expect(calls.filter((call) => call.url === '/api/today')).toHaveLength(1)
  })

  it('puts a shared text without photos into the field and sends nothing', async () => {
    const id = newShareId()
    await keepShare(storage, id, Date.now(), [], { title: 'Ein Rezept', url: 'https://example.com/rezept' })
    await show(`/schnell?geteilt=${id}`)
    await until(() => field().value !== '', 'the text in the field')
    await idle()
    expect(field().value).toBe('Ein Rezept\nhttps://example.com/rezept')
    expect(uploads()).toHaveLength(0)
    expect(notes()).toHaveLength(0)
    expect(storage.addresses()).toEqual([])
  })

  it('refuses more than ten photos at once, uploads none of them and clears them away', async () => {
    const id = newShareId()
    await keepShare(storage, id, Date.now(), Array.from({ length: 11 }, () => picture()), { text: 'zu viele' })
    await show(`/schnell?geteilt=${id}`)
    await until(() => alerts().length > 0, 'the message')
    expect(alerts()).toEqual(['Höchstens 10 Fotos auf einmal. Teile bitte weniger.'])
    expect(uploads()).toHaveLength(0)
    expect(notes()).toHaveLength(0)
    expect(storage.addresses()).toEqual([])
  })

  it('takes ten photos, the most there may be', async () => {
    const id = newShareId()
    await keepShare(storage, id, Date.now(), Array.from({ length: 10 }, () => picture()))
    await show(`/schnell?geteilt=${id}`)
    await until(() => notes().length === 10, 'ten notes')
    expect(alerts()).toEqual([])
  })

  it('says what the service worker could not keep', async () => {
    await show('/schnell?geteilt=zuviele')
    expect(alerts()).toEqual(['Höchstens 10 Fotos auf einmal. Teile bitte weniger.'])
    act(() => root.unmount())
    box.remove()
    await show('/schnell?geteilt=verloren')
    expect(alerts()).toEqual(['Die geteilten Fotos sind nicht angekommen. Teile sie bitte noch einmal.'])
    expect(address).toBe('/schnell')
  })

  it('says honestly when the share is no longer there (too old, or taken already)', async () => {
    const id = newShareId()
    await keepShare(storage, id, Date.now() - 31 * 60 * 1000, [picture()])
    await show(`/schnell?geteilt=${id}`)
    await until(() => alerts().length > 0, 'the message')
    expect(alerts()).toEqual(['Die geteilten Fotos sind nicht angekommen. Teile sie bitte noch einmal.'])
    expect(uploads()).toHaveLength(0)
    expect(storage.addresses()).toEqual([])
  })

  it('says a refused photo as on any upload, and the others still become notes with the text', async () => {
    const id = newShareId()
    await keepShare(storage, id, Date.now(), [picture(10, 'text/plain'), picture(20), picture(5000)], { text: 'nur eins passt' })
    await show(`/schnell?geteilt=${id}`)
    await until(() => alerts().length > 0 && uploads().length === 3, 'the message')
    await idle()
    expect(notes().map((note) => [note.text, note.photo_id])).toEqual([['nur eins passt', `01${'f'.repeat(30)}`]])
    expect(alerts()).toEqual(['Das Foto ist zu groß, höchstens 20 MB.'])
    expect(storage.addresses()).toEqual([])
  })

  it('keeps the text in the field when no photo could be taken', async () => {
    const id = newShareId()
    await keepShare(storage, id, Date.now(), [picture(10, 'application/pdf')], { text: 'ein beleg' })
    await show(`/schnell?geteilt=${id}`)
    await until(() => alerts().length > 0, 'the message')
    expect(alerts()).toEqual(['Das ist kein Foto, das nexdiary annimmt (JPEG, PNG, WebP, HEIC oder AVIF).'])
    expect(notes()).toHaveLength(0)
    expect(field().value).toBe('ein beleg')
  })

  it('asks which day after midnight before a photo goes up, and puts photo and note on that day', async () => {
    today = base('2026-10-10', { night: night(null) })
    const id = newShareId()
    await keepShare(storage, id, Date.now(), [picture(), picture()], { text: 'spät noch' })
    await show(`/schnell?geteilt=${id}`)
    const asked = await until(dialog, 'the question')
    expect(uploads()).toHaveLength(0)
    await act(async () => (asked.querySelectorAll('button:not([data-close])')[0] as HTMLButtonElement).click())
    await until(() => notes().length === 2, 'two notes')
    const order = calls.map((call) => `${call.method} ${call.url.split('?')[0]}`)
    expect(order.indexOf('PUT /api/night')).toBeLessThan(order.indexOf('POST /api/photos'))
    expect(notes()[0].text).toBe('spät noch')
    expect(storage.addresses()).toEqual([])
  })

  it('uploads nothing when the question after midnight is put away, and says to share again', async () => {
    today = base('2026-10-10', { night: night(null) })
    const id = newShareId()
    await keepShare(storage, id, Date.now(), [picture()])
    await show(`/schnell?geteilt=${id}`)
    await until(dialog, 'the question')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    await until(() => alerts().length > 0, 'the message')
    expect(alerts()).toEqual(['Ohne Antwort, zu welchem Tag sie gehören, sind die geteilten Fotos nicht abgelegt. Teile sie bitte noch einmal.'])
    expect(uploads()).toHaveLength(0)
    expect(storage.addresses()).toEqual([])
  })
})
