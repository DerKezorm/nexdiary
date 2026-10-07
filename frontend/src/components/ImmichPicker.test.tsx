/**
 * "Aus Immich wählen" against a server stand-in: it opens on the whole collection newest first, grouped by month, more
 * on a request; a day or a month to jump to is a help on top and the entry's day only a mark; albums are left out (with a
 * word) where the key may not read them; the search sends its word in a body; a photo is copied only when it is tapped,
 * and what goes wrong is said while the dialog stays.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ImmichEntry } from '../api/client'
import { ApiError } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { ImmichPicker } from './ImmichPicker'

vi.mock('../state/auth', () => ({ useAuth: () => ({ me: { name: 'jule', profile: { timezone: 'Europe/Berlin' } } }) }))

const id = (n: number) => `a1a1a1a1-0000-4000-8000-${String(n).padStart(12, '0')}`
const entry = (n: number, taken: string): ImmichEntry => ({ id: id(n), taken_at: taken })

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let timeline: (page: number, until: string) => { photos: ImmichEntry[]; next: number | null }
let albums: { available: boolean; albums: { id: string; name: string; count: number; cover: string | null }[] }
let search: (q: string, page: number) => { photos: ImmichEntry[]; next: number | null; mode: string } | number

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.startsWith('/api/immich/timeline')) {
        const query = new URL(url, 'http://x').searchParams
        return json(timeline(Number(query.get('page')), query.get('until') ?? ''))
      }
      if (url === '/api/immich/albums') return json(albums)
      if (url.startsWith('/api/immich/albums/')) return json({ photos: [entry(90, '2025-07-01T10:00:00+00:00')], next: null })
      if (url === '/api/immich/search') {
        const found = search(body!.q as string, body!.page as number)
        return typeof found === 'number' ? json({ detail: { code: 'immich_unreachable', message: 'x' } }, found) : json(found)
      }
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement
const picked: string[] = []
let pick: (found: ImmichEntry) => Promise<void>
let closed = 0

async function settle(ms = 20): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)))
}

async function show(day = '2026-10-06'): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => root.render(<ImmichPicker date={day} onClose={() => closed++} onPick={(found) => pick(found)} />))
  await settle(40)
}

const tiles = () => [...document.querySelectorAll<HTMLButtonElement>('[data-immich-tiles] button:has(img)')]
const named = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button, [role=tab]')].find((item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)!
const urls = () => calls.map((call) => call.url)

beforeEach(async () => {
  await changeLanguage('de', false)
  picked.length = 0
  closed = 0
  pick = async (found) => void picked.push(found.id)
  timeline = (page) => (page === 1 ? { photos: [entry(1, '2026-10-05T10:00:00+00:00'), entry(2, '2026-09-20T10:00:00+00:00'), entry(3, '2026-09-02T10:00:00+00:00')], next: 2 } : { photos: [entry(4, '2025-12-24T10:00:00+00:00')], next: null })
  albums = { available: true, albums: [{ id: id(500), name: 'Sommer', count: 3, cover: id(1) }] }
  search = () => ({ photos: [entry(70, '2025-06-01T10:00:00+00:00')], next: null, mode: 'smart' })
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('the whole collection', () => {
  it('opens on the newest photos, grouped by month, with no filter on the day of the entry', async () => {
    await show()
    expect(tiles()).toHaveLength(3)
    expect([...document.querySelectorAll('[data-immich-tiles] h3')].map((heading) => heading.textContent)).toEqual(['Oktober 2026', 'September 2026'])
    const first = calls.find((call) => call.url.startsWith('/api/immich/timeline'))!
    expect(first.url).toBe('/api/immich/timeline?page=1')
    expect(document.body.textContent).toContain('egal wann es aufgenommen wurde')
    expect(tiles()[0].querySelector('img')!.getAttribute('src')).toBe(`/api/immich/photos/${id(1)}/thumbnail`)
  })

  it('loads the next page when asked, with the photos before it, and stops where there is no more', async () => {
    await show()
    await act(async () => named('Mehr laden').click())
    await settle()
    expect(tiles()).toHaveLength(4)
    expect(urls().filter((url) => url.startsWith('/api/immich/timeline'))).toEqual(['/api/immich/timeline?page=1', '/api/immich/timeline?page=2'])
    expect([...document.querySelectorAll('[data-immich-tiles] h3')].at(-1)?.textContent).toBe('Dezember 2025')
    expect(document.body.textContent).not.toContain('Mehr laden')
  })

  it('does not show a photo twice when a page repeats one', async () => {
    timeline = (page) => (page === 1 ? { photos: [entry(1, '2026-10-05T10:00:00+00:00')], next: 2 } : { photos: [entry(1, '2026-10-05T10:00:00+00:00'), entry(2, '2026-10-04T10:00:00+00:00')], next: null })
    await show()
    await act(async () => named('Mehr laden').click())
    await settle()
    expect(tiles()).toHaveLength(2)
  })

  it('jumps to a day, a month, the day of the entry and back to the newest, starting afresh each time', async () => {
    await show('2026-10-06')
    const day = document.querySelector<HTMLInputElement>('input[type=date]')!
    expect(day.value).toBe('2026-10-06')
    const set = (field: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setter.call(field, value)
        field.dispatchEvent(new Event('change', { bubbles: true }))
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    set(day, '2025-08-03')
    await settle()
    expect(urls().at(-1)).toBe('/api/immich/timeline?page=1&until=2025-08-03')
    await act(async () => named('Einen Tag später').click())
    await settle()
    expect(urls().at(-1)).toBe('/api/immich/timeline?page=1&until=2025-08-04')
    await act(async () => named('Einen Tag früher').click())
    await settle()
    expect(urls().at(-1)).toBe('/api/immich/timeline?page=1&until=2025-08-03')
    set(document.querySelector<HTMLInputElement>('input[type=month]')!, '2026-09')
    await settle()
    expect(urls().at(-1)).toBe('/api/immich/timeline?page=1&until=2026-09')
    await act(async () => named('Zu diesem Tag').click())
    await settle()
    expect(urls().at(-1)).toBe('/api/immich/timeline?page=1&until=2026-10-06')
    await act(async () => named('Zu den neuesten').click())
    await settle()
    expect(urls().at(-1)).toBe('/api/immich/timeline?page=1')
    expect(tiles()).toHaveLength(3)
  })

  it('says so when there is nothing', async () => {
    timeline = () => ({ photos: [], next: null })
    await show()
    expect(document.body.textContent).toContain('Keine Fotos gefunden.')
  })

  it('says what went wrong, quietly, and the rest stays', async () => {
    timeline = () => {
      throw new Error('unused')
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.startsWith('/api/immich/timeline') ? new Response(JSON.stringify({ detail: { code: 'immich_unreachable', message: 'x' } }), { status: 502, headers: { 'Content-Type': 'application/json' } }) : new Response(JSON.stringify(albums), { status: 200, headers: { 'Content-Type': 'application/json' } }))))
    await show()
    expect(document.querySelector('[role=alert]')?.textContent).toContain('erreicht dein Immich nicht')
    expect(named('Suche')).toBeTruthy()
  })
})

describe('taking a photo', () => {
  it('copies only the photo that is tapped and closes the dialog', async () => {
    await show()
    expect(picked).toEqual([])
    await act(async () => tiles()[1].click())
    await settle()
    expect(picked).toEqual([id(2)])
    expect(closed).toBe(1)
  })

  it('stays open and says why when the photo cannot be taken', async () => {
    pick = async () => {
      throw new ApiError(422, 'immich_not_a_picture')
    }
    await show()
    await act(async () => tiles()[0].click())
    await settle()
    expect(closed).toBe(0)
    expect(document.querySelector('[role=alert]')?.textContent).toContain('nexdiary nicht übernehmen')
    // And it can be tried again.
    pick = async (found) => void picked.push(found.id)
    await act(async () => tiles()[0].click())
    await settle()
    expect(picked).toEqual([id(1)])
  })

  it('takes one photo at a time: a second tap while the first is on its way does nothing', async () => {
    let release: () => void = () => undefined
    pick = (found) => new Promise<void>((resolve) => {
      picked.push(found.id)
      release = resolve
    })
    await show()
    await act(async () => tiles()[0].click())
    await act(async () => tiles()[1].click())
    expect(picked).toEqual([id(1)])
    expect(tiles().every((tile) => tile.disabled)).toBe(true)
    await act(async () => release())
    await settle()
    expect(closed).toBe(1)
  })
})

describe('albums', () => {
  it('lists the albums and opens one, with a way back', async () => {
    await show()
    await act(async () => named('Alben').click())
    await settle()
    expect(document.querySelector('[data-immich-albums]')?.textContent).toContain('Sommer')
    expect(document.querySelector('[data-immich-albums]')?.textContent).toContain('3 Fotos')
    await act(async () => document.querySelector<HTMLButtonElement>('[data-immich-albums] button')!.click())
    await settle()
    expect(urls().at(-1)).toBe(`/api/immich/albums/${id(500)}/photos?page=1`)
    expect(tiles()).toHaveLength(1)
    await act(async () => named('Alle Alben').click())
    expect(document.querySelector('[data-immich-albums]')).toBeTruthy()
  })

  it('leaves the albums out, with a word about the permission, where the key may not read them', async () => {
    albums = { available: false, albums: [] }
    await show()
    expect(named('Alben')).toBeUndefined()
    expect(document.body.textContent).toContain('album.read')
    expect(named('Alle Fotos')).toBeTruthy()
  })
})

describe('the search', () => {
  const type = (value: string) => {
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Suchbegriff"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('sends the word in a body, never in an address, and shows what Immich finds', async () => {
    await show()
    await act(async () => named('Suche').click())
    expect(document.body.textContent).toContain('Gib einen Begriff ein')
    expect(urls().some((url) => url === '/api/immich/search')).toBe(false)
    type('strand')
    await act(async () => named('Suchen').click())
    await settle()
    const sent = calls.find((call) => call.url === '/api/immich/search')!
    expect(sent.method).toBe('POST')
    expect(sent.body).toEqual({ q: 'strand', page: 1 })
    expect(urls().some((url) => url.includes('strand'))).toBe(false)
    expect(tiles()).toHaveLength(1)
    expect(document.body.textContent).toContain('was auf den Fotos zu sehen ist')
  })

  it('tells when Immich has no smart search and when nothing is found', async () => {
    search = () => ({ photos: [], next: null, mode: 'metadata' })
    await show()
    await act(async () => named('Suche').click())
    type('nichts')
    await act(async () => named('Suchen').click())
    await settle()
    expect(document.body.textContent).toContain('Die intelligente Suche ist in Immich nicht eingeschaltet')
    expect(document.body.textContent).toContain('Dazu gibt es keine Fotos.')
  })

  it('does not search for nothing', async () => {
    await show()
    await act(async () => named('Suche').click())
    expect(named('Suchen').disabled).toBe(true)
    type('   ')
    expect(named('Suchen').disabled).toBe(true)
  })

  it('says what went wrong with a search', async () => {
    search = () => 502
    await show()
    await act(async () => named('Suche').click())
    type('strand')
    await act(async () => named('Suchen').click())
    await settle()
    expect(document.querySelector('[role=alert]')).toBeTruthy()
  })
})
