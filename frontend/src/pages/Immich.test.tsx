/**
 * Immich in the interface, against a server stand-in: the person's card says only that the operator has not allowed
 * it while the bolt is closed, never shows a key, and saves and checks; "Fotos von heute" shows the photos of Immich,
 * copies one only when it is chosen and puts it back with another tap, says quietly when Immich does not answer and
 * nothing when there is none; the cover picker takes a photo of Immich and makes it the cover.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import type { ImmichPhoto, Photo, Profile } from '../api/client'
import { CoverPicker } from '../covers/Cover'
import '../i18n'
import { changeLanguage } from '../i18n'
import { ImmichCard, ImmichServerCard } from './settings/ImmichCards'
import { TodayPage } from './TodayPage'
import { idle } from '../test/wait'

const me: { name: string; display_name: string; profile: Profile } = {
  name: 'jule',
  display_name: 'Jule',
  profile: { palette: 'salbei', mode: 'system', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true },
}
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))

const A1 = 'a1a1a1a1-0000-4000-8000-000000000001'
const A2 = 'a2a2a2a2-0000-4000-8000-000000000002'
const PHOTO: Photo = { id: 'f'.repeat(32), date: '2026-10-06', source: 'immich', width: 1200, height: 900, created_at: '2026-10-06T16:00:00+00:00', on_note: false }

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let today: Record<string, unknown>
let state: Record<string, unknown>
let day: { status: number; data: unknown }

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.startsWith('/api/today')) return json(today)
      if (url === '/api/ai') return json({ provider: 'none', to: '', model: '', mine: true, available: false })
      // "Today" shows what was uploaded lately; the writing view and the cover picker the photos of their day.
      if (url.startsWith('/api/immich/recent') || url.startsWith('/api/immich/photos?') || url === '/api/immich/photos') return json(day.data, day.status)
      if (url === `/api/immich/photos/${A1}` && method === 'POST') return json(PHOTO, 201)
      if (url === `/api/photos/${PHOTO.id}` && method === 'DELETE') return new Response(null, { status: 204 })
      if (url === '/api/immich' && method === 'GET') return json(state)
      if (url === '/api/immich' && method === 'PUT') {
        state = { ...state, connected: true, url: body!.url ?? state.url, key_set: true }
        return json(state)
      }
      if (url === '/api/immich/probe') return json({ version: '1.132.3', today: 5, more: false, email: 'jule@example.com' })
      if (url === '/api/settings/immich' && method === 'GET') return json({ allowed: false, hosts: [], connected: 0 })
      if (url === '/api/settings/immich' && method === 'PUT') return json({ allowed: body!.allowed ?? true, hosts: body!.hosts ?? [], connected: 2 })
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


function button(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)
}

function tiles(): HTMLButtonElement[] {
  return [...box.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].filter((item) => item.querySelector('img[src*="/api/immich/"]'))
}

beforeEach(async () => {
  await changeLanguage('de', false)
  today = { date: '2026-10-06', notes: [], day: null, values: [], streak: 4, photos: [], question: null }
  state = { allowed: true, connected: false, url: '', key_set: false, suggest: true, email: '', version: '' }
  day = {
    status: 200,
    data: {
      date: '2026-10-06',
      more: false,
      photos: [
        { id: A1, taken_at: '2026-10-06T05:20:00+00:00', photo_id: null },
        { id: A2, taken_at: '2026-10-06T10:18:00+00:00', photo_id: null },
      ],
    },
  }
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('the own Immich card', () => {
  it('says only that the operator has not allowed it, with no field', async () => {
    state = { allowed: false, connected: false }
    await show(<ImmichCard />)
    expect(box.textContent).toContain('Dein Betreiber hat Immich nicht freigegeben.')
    expect(box.querySelectorAll('input')).toHaveLength(0)
  })

  it('saves and checks, and never shows a key', async () => {
    await show(<ImmichCard />)
    const [url, key] = [...box.querySelectorAll<HTMLInputElement>('input')]
    expect(key.type).toBe('password')
    const set = (field: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setter.call(field, value)
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    set(url, 'https://photos.example.com')
    set(key, 'made-for-this-test')
    await act(async () => button('Speichern und prüfen')!.click())
    await idle()
    const saved = calls.find((call) => call.url === '/api/immich' && call.method === 'PUT')
    expect(saved?.body).toEqual({ url: 'https://photos.example.com', suggest: true, key: 'made-for-this-test' })
    expect(calls.some((call) => call.url === '/api/immich/probe')).toBe(true)
    expect(box.textContent).toContain('Verbindung geprüft: Immich 1.132.3, 5 Fotos von heute.')
    expect(key.value).toBe('')
    expect(key.placeholder).toBe('gespeichert, leer lassen zum Behalten')
    expect(button('Trennen')).toBeTruthy()
  })
})

describe('the operator card', () => {
  it('opens Immich and keeps one host per line', async () => {
    await show(<ImmichServerCard />)
    await act(async () => box.querySelector<HTMLButtonElement>('button[role="switch"]')!.click())
    await idle()
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ allowed: true })
    const area = box.querySelector('textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    act(() => {
      setter.call(area, ' photos.example.com \n\nimmich.example.com:2283\n')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Speichern')!.click())
    await idle()
    expect(calls.filter((call) => call.method === 'PUT').at(-1)?.body).toEqual({ hosts: ['photos.example.com', 'immich.example.com:2283'] })
    expect(box.textContent).toContain('2 Personen haben Immich verbunden.')
  })
})

describe('the photos of today from Immich', () => {
  beforeEach(() => {
    state = { allowed: true, connected: true, url: 'https://photos.example.com', key_set: true, suggest: true, email: '', version: '' }
  })

  it('does not ask for the photos while Immich is closed, not connected or switched off', async () => {
    for (const closed of [{ allowed: false, connected: false }, { ...state, connected: false }, { ...state, suggest: false }]) {
      state = closed
      calls = []
      await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
      expect(calls.some((call) => call.url.startsWith('/api/immich/photos'))).toBe(false)
      expect(calls.some((call) => call.url === '/api/immich')).toBe(true)
      expect(box.textContent).not.toContain('Immich')
      act(() => root.unmount())
      box.remove()
    }
    state = { allowed: true, connected: true, suggest: true }
  })

  it('copies a photo only when it is chosen, and puts it back with another tap', async () => {
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    expect(tiles()).toHaveLength(2)
    expect(box.textContent).toContain('aus Immich · 0 gewählt')
    expect(calls.some((call) => call.method === 'POST' && call.url.startsWith('/api/immich/photos/'))).toBe(false)
    await act(async () => tiles()[0].click())
    await idle()
    expect(calls.filter((call) => call.method === 'POST' && call.url === `/api/immich/photos/${A1}`)).toHaveLength(1)
    expect(tiles()[0].getAttribute('aria-pressed')).toBe('true')
    expect(box.textContent).toContain('aus Immich · 1 gewählt')
    // Shown as its tile, not a second time among the own photos.
    expect(box.querySelectorAll(`img[src="/api/photos/${PHOTO.id}/preview"]`)).toHaveLength(0)
    await act(async () => tiles()[0].click())
    await idle()
    expect(calls.some((call) => call.method === 'DELETE' && call.url === `/api/photos/${PHOTO.id}`)).toBe(true)
    expect(box.textContent).toContain('aus Immich · 0 gewählt')
  })

  it('says quietly when Immich does not answer, and the rest goes on', async () => {
    day = { status: 502, data: { detail: { code: 'immich_unreachable', message: 'x' } } }
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    expect(box.textContent).toContain('Immich ist gerade nicht erreichbar. Alles andere geht wie immer.')
    expect(button('Hochladen')).toBeTruthy()
    expect(box.querySelector('[role="alert"]')).toBeNull()
  })

  it('says nothing at all without Immich', async () => {
    day = { status: 409, data: { detail: { code: 'immich_not_connected', message: 'x' } } }
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    expect(box.textContent).not.toContain('Immich')
    expect(box.textContent).toContain('0 Fotos')
  })
})

describe('the cover picker', () => {
  it('takes a photo of Immich and makes it the cover', async () => {
    const chosen: string[] = []
    const taken: ImmichPhoto[] = []
    await show(
      <CoverPicker
        date="2026-10-06"
        tags={[]}
        photos={[]}
        value="illu:baum.abend.herbst"
        onChange={(cover) => chosen.push(cover)}
        onClose={() => undefined}
        immich={[{ id: A1, taken_at: '2026-10-06T05:20:00+00:00', photo_id: null }]}
        onImmich={async (entry) => {
          taken.push(entry)
          return PHOTO.id
        }}
      />,
    )
    const tile = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.querySelector(`img[src="/api/immich/photos/${A1}/thumbnail"]`))
    expect(tile).toBeTruthy()
    expect(document.body.textContent).toContain('Deine Fotos von diesem Tag')
    await act(async () => tile!.click())
    await idle()
    expect(taken.map((entry) => entry.id)).toEqual([A1])
    expect(chosen).toEqual([`photo:${PHOTO.id}`])
  })
})
