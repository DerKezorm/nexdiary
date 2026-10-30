/**
 * "Fotos dazulegen" on an older day (A1): in "Tag lesen" and in the writing view, several photos at once go to that
 * day and stand under the text; none becomes the cover, which stays as it was. The notice says so. A locked day has no
 * button for it. The attachments of the day stand beneath the photos, above the tags.
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import '../i18n'
import { changeLanguage } from '../i18n'
import { eventually, idle, until } from '../test/wait'
import { EntryPage } from './EntryPage'
import WritePage from './WritePage'

vi.mock('../state/auth', () => ({
  useAuth: () => ({ me: { id: 1, name: 'jule', display_name: 'Jule', sign_in: 'password', profile: { mode: 'light', layout: 'page', journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'manual' } } }),
}))

const DATE = '2026-09-12'
const hex = (n: number) => String(n).repeat(32).slice(0, 32)
type Call = { method: string; url: string; body: unknown }
let calls: Call[] = []
let day: Record<string, unknown> | null = null
let photos: Record<string, unknown>[] = []
let uploaded = 0
let attachments: Record<string, unknown>[] = []

function page(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { date: DATE, title: 'Pilze', text: 'Im Wald.', tags: ['wald'], values: {}, cover: 'illu:baum.abend.herbst', cover_chosen: true, written_by: 'self', words: 2, revision: 3, locked: false, locked_at: null, created_at: '', updated_at: '', ...extra }
}

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      const address = new URL(url, 'http://x')
      if (address.pathname === '/api/photos' && method === 'POST') {
        uploaded += 1
        const photo = { id: hex(uploaded), date: address.searchParams.get('date'), source: 'upload', width: 400, height: 300, created_at: '', on_note: false }
        photos.push(photo)
        return json(photo, 201)
      }
      if (address.pathname === '/api/photos') return json(photos)
      if (address.pathname === `/api/days/${DATE}` && method === 'GET') return day ? json(day) : json({ detail: { code: 'not_found', message: 'x' } }, 404)
      if (address.pathname === `/api/days/${DATE}/shares`) return json({ date: DATE, people: [], with_values: false, with_notes: false })
      if (address.pathname === `/api/days/${DATE}/draft` && method === 'GET') return json(null)
      if (address.pathname === `/api/days/${DATE}/draft`) return json({ ...body, updated_at: '' })
      if (address.pathname === '/api/attachments') return json({ attachments })
      if (address.pathname === '/api/immich') return json({ allowed: false, connected: false })
      if (address.pathname === '/api/ai') return json({ provider: 'none', to: '', model: '', mine: true, available: false })
      if (address.pathname === '/api/journal') return json({ days: [], more: false })
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement
let notice: unknown = null

function Notice() {
  const state = useLocation().state as { notice?: unknown } | null
  useEffect(() => {
    if (state?.notice) notice = state.notice
  }, [state])
  return null
}

async function show(path: string, ready: () => unknown): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  box.id = 'root'
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Notice />
        <Routes>
          <Route path="/tag/:date" element={<EntryPage />} />
          <Route path="/tag/:date/schreiben" element={<WritePage />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await until(ready, 'the page')
  await idle()
}

async function choosePhotos(names: string[]): Promise<void> {
  const input = await until(() => box.querySelector<HTMLInputElement>('[data-photos-input]'), 'the photo picker')
  expect(input.accept).toBe('image/*')
  expect(input.multiple).toBe(true)
  const files = names.map((name) => new File([new Uint8Array(8)], name, { type: 'image/jpeg' }))
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
  await idle()
}

const uploads = () => calls.filter((call) => call.method === 'POST' && call.url.startsWith('/api/photos?'))

beforeEach(async () => {
  await changeLanguage('de', false)
  day = page()
  photos = []
  uploaded = 0
  attachments = []
  notice = null
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('reading a day', () => {
  it('lays several photos onto the day, under the text, and leaves the cover as it is', async () => {
    await show(`/tag/${DATE}`, () => box.querySelector('h1'))
    const section = box.querySelector('[data-attachments]')!
    expect(section).not.toBeNull()
    // Below the text, above the tags.
    expect(box.querySelector('.prose-diary')!.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(section.compareDocumentPosition([...box.querySelectorAll('span')].find((span) => span.textContent === '#wald')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await choosePhotos(['a.jpg', 'b.jpg'])
    expect(uploads()).toHaveLength(2)
    for (const call of uploads()) {
      const query = new URL(call.url, 'http://x').searchParams
      expect(query.get('date')).toBe(DATE)
      expect(query.has('note')).toBe(false)
      expect(query.get('upload_id')).toMatch(/^[0-9a-f-]{36}$/)
    }
    // The cover stays: nothing about the day itself is sent.
    expect(calls.filter((call) => call.url === `/api/days/${DATE}` && call.method === 'PUT')).toHaveLength(0)
    await eventually(() => expect([...box.querySelectorAll('img')].filter((img) => img.getAttribute('src')?.startsWith('/api/photos/')).map((img) => img.getAttribute('src'))).toEqual([`/api/photos/${hex(1)}/preview`, `/api/photos/${hex(2)}/preview`]))
    expect(notice).toBe('2 Fotos dazugelegt. Das Titelbild bleibt.')
  })

  it('offers neither the photos nor attaching on a locked day', async () => {
    day = page({ locked: true, locked_at: '2026-09-20T10:00:00+00:00' })
    await show(`/tag/${DATE}`, () => box.querySelector('h1'))
    expect(box.querySelector('[data-photos-input]')).toBeNull()
    expect(box.querySelector('[data-attach]')).toBeNull()
    expect(box.querySelector('[data-attachments]')).toBeNull()
    // Its attachments still show, read only.
    act(() => root.unmount())
    attachments = [{ id: hex(7), date: DATE, kind: 'link', name: 'Pilzführer', url: 'https://pilze.example.com', size: 0, seconds: null, width: null, height: null, codec: null, status: 'ready', progress: null, playable: true, can_convert: false, has_preview: false, created_at: '' }]
    await show(`/tag/${DATE}`, () => box.querySelector('[data-attachments]'))
    expect(box.querySelector('[data-attachments]')!.textContent).toContain('Pilzführer')
    expect(box.querySelector('[data-attach]')).toBeNull()
    expect(box.querySelector('[data-photos-input]')).toBeNull()
    expect(box.querySelector('button[aria-label="Anhang löschen"]')).toBeNull()
  })
})

describe('writing a day', () => {
  it('lays a photo onto a day without a page, and the cover shown before stays the cover', async () => {
    day = null
    await show(`/tag/${DATE}/schreiben`, () => box.querySelector('[contenteditable]'))
    const card = box.querySelector('[data-attachments]')!
    expect(card.querySelector('h2')!.textContent).toBe('Anhänge')
    // The illustration is the cover while no photo is there.
    const coverPhoto = () => box.querySelector('article img[alt="Titelbild"]')
    expect(coverPhoto()).toBeNull()
    await choosePhotos(['pilz.jpg'])
    expect(uploads()).toHaveLength(1)
    expect(new URL(uploads()[0].url, 'http://x').searchParams.get('date')).toBe(DATE)
    // Before, the first photo of a day became its cover by itself; laid onto the day it does not.
    expect(coverPhoto()).toBeNull()
    expect(notice).toBe('Foto dazugelegt. Das Titelbild bleibt.')
  })
})
