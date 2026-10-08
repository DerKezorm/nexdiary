/**
 * "My photos": the storage line, the photos by month with where each is used (linked) or that none is, the filter for
 * what nothing uses, the next page when asked, the big view with its arrows, and choosing several to delete at once.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import type { LibraryPage as Page, LibraryPhoto } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { LightboxProvider } from '../components/Lightbox'
import { PhotoDeleteProvider } from '../components/PhotoDelete'
import { eventually, idle, until } from '../test/wait'
import { LibraryPage } from './LibraryPage'

const me = { profile: { timezone: 'Europe/Berlin' } }
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))

type Call = { method: string; url: string; body: unknown }
let calls: Call[] = []
let root: Root
let box: HTMLDivElement
let storage = { used: 1288490189, limit: 5 * 1024 ** 3, count: 5 }
let failLibrary: string | null = null
let emptyLibrary = false

const id = (n: number) => String(n).repeat(32).slice(0, 32)

function photo(n: number, date: string, uses: Partial<LibraryPhoto['uses']> = {}): LibraryPhoto {
  return { id: id(n), date, source: 'upload', width: 4000, height: 3000, created_at: `${date}T10:00:00+00:00`, on_note: false, for_text: false, uses: { cover: false, text: false, notes: [], ...uses } }
}

const FIRST: LibraryPhoto[] = [
  photo(1, '2026-10-07', { notes: [{ id: 'n1', date: '2026-10-07' }] }),
  photo(2, '2026-10-04', { cover: true, text: true }),
  photo(3, '2026-09-30'),
]
const SECOND: LibraryPhoto[] = [photo(4, '2026-09-12', { notes: [{ id: 'n2', date: '2026-09-11' }] }), photo(5, '2026-08-01')]

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      const address = new URL(url, 'http://x')
      if (address.pathname === '/api/photos/library') {
        if (failLibrary) return json({ detail: { code: failLibrary, message: 'x' } }, 500)
        if (emptyLibrary) return json({ photos: [], next: null } satisfies Page)
        const unused = address.searchParams.get('unused') === '1'
        const before = address.searchParams.get('before')
        const all: LibraryPage_ = before ? { photos: SECOND, next: null } : { photos: FIRST, next: 'cursor-1' }
        const kept = unused ? all.photos.filter((item) => !item.uses.cover && !item.uses.text && item.uses.notes.length === 0) : all.photos
        return json({ photos: kept, next: before ? null : unused ? null : all.next } satisfies Page)
      }
      if (address.pathname === '/api/photos/storage') return json(storage)
      if (address.pathname === '/api/photos/delete') return json({ deleted: body.ids, locked: [], missing: [] })
      return json({})
    }),
  )
}
type LibraryPage_ = Page

async function show(): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  box.id = 'root'
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter>
        <PhotoDeleteProvider>
          <LightboxProvider>
            <LibraryPage />
          </LightboxProvider>
        </PhotoDeleteProvider>
      </MemoryRouter>,
    ),
  )
  await idle()
}

const tiles = () => [...box.querySelectorAll<HTMLElement>('li[data-photo]')]
const tile = (n: number) => box.querySelector<HTMLElement>(`li[data-photo="${id(n)}"]`)!
const button = (label: string) => [...box.querySelectorAll('button')].find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)

beforeEach(async () => {
  // The notes of "today" are those of 7 October: only the date is set, every timer stays real.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
  await changeLanguage('de', false)
  storage = { used: 1288490189, limit: 5 * 1024 ** 3, count: 5 }
  failLibrary = null
  emptyLibrary = false
  serve()
})

afterEach(async () => {
  await act(async () => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the storage line', () => {
  it('says how much of the limit the photos take, and how many there are', async () => {
    await show()
    const line = box.querySelector('[data-testid="storage"]')!
    expect(line.textContent).toContain('1,2 GB von 5 GB belegt')
    expect(line.textContent).toContain('5 Fotos')
    expect(line.querySelector('[role=img]')!.getAttribute('aria-label')).toBe('24 Prozent deines Platzes belegt')
  })

  it('has no bar without a limit, and speaks English in English', async () => {
    storage = { used: 52428800, limit: null as unknown as number, count: 1 }
    await changeLanguage('en', false)
    await show()
    const line = box.querySelector('[data-testid="storage"]')!
    expect(line.textContent).toContain('50 MB used')
    expect(line.textContent).toContain('1 photo')
    expect(line.querySelector('[role=img]')).toBeNull()
  })
})

describe('the photos', () => {
  it('groups them by month, newest first, and links each use to its day', async () => {
    await show()
    expect([...box.querySelectorAll('section h2')].map((heading) => heading.textContent)).toEqual(['Oktober 2026', 'September 2026'])
    expect(tiles().map((item) => item.getAttribute('data-photo'))).toEqual([id(1), id(2), id(3)])
    const links = (n: number) => [...tile(n).querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href')])
    // A note of today leads to "Today", the cover and the text of a day to that day.
    expect(links(1)).toEqual([['An Notiz vom 7. Oktober', '/']])
    expect(links(2)).toEqual([['Titelbild von 4. Oktober', '/tag/2026-10-04'], ['Im Text von 4. Oktober', '/tag/2026-10-04']])
    expect(tile(2).querySelector('[data-unused]')).toBeNull()
    // Nothing uses it: said so, with the day.
    expect(tile(3).querySelector('[data-unused]')!.textContent).toContain('Nicht verwendet')
    expect(links(3)).toEqual([['30. September', '/tag/2026-09-30']])
    // The small copies in the grid, not the originals.
    expect(tile(1).querySelector('img')!.getAttribute('src')).toBe(`/api/photos/${id(1)}/preview`)
  })

  it('loads the next page when asked and joins the months', async () => {
    await show()
    await act(async () => button('Mehr laden')!.click())
    await until(() => tiles().length === 5, 'the next page')
    expect(calls.filter((call) => call.url.startsWith('/api/photos/library')).map((call) => new URL(call.url, 'http://x').searchParams.get('before'))).toEqual([null, 'cursor-1'])
    expect([...box.querySelectorAll('section h2')].map((heading) => heading.textContent)).toEqual(['Oktober 2026', 'September 2026', 'August 2026'])
    expect(button('Mehr laden')).toBeUndefined()
    // September 30 and September 12 stand in one month.
    expect([...box.querySelectorAll('section')[1].querySelectorAll('li[data-photo]')].map((item) => item.getAttribute('data-photo'))).toEqual([id(3), id(4)])
  })

  it('keeps only what nothing uses on the filter, asked of the server', async () => {
    await show()
    await act(async () => button('Nicht verwendet')!.click())
    await until(() => tiles().length === 1, 'the filter')
    expect(tiles()[0].getAttribute('data-photo')).toBe(id(3))
    expect(calls.filter((call) => call.url.startsWith('/api/photos/library')).pop()!.url).toContain('unused=1')
  })

  it('says kindly when there is nothing', async () => {
    storage = { used: 0, limit: 5 * 1024 ** 3, count: 0 }
    emptyLibrary = true
    await show()
    expect(box.querySelector('[data-testid="library-empty"]')!.textContent).toContain('noch keine Fotos')
    expect(button('Auswählen')).toBeUndefined()
  })

  it('says what went wrong in words', async () => {
    failLibrary = 'internal_error'
    await show()
    expect(box.querySelector('[role=alert]')!.textContent?.length).toBeGreaterThan(10)
    expect(tiles()).toHaveLength(0)
  })
})

describe('the big view and deleting', () => {
  it('opens the original on a tap and runs through all the loaded photos', async () => {
    await show()
    await act(async () => tile(2).querySelector('button')!.click())
    const view = await until(() => document.querySelector<HTMLElement>('[data-lightbox]'), 'the big view')
    expect(view.querySelector('img')!.getAttribute('src')).toBe(`/api/photos/${id(2)}`)
    expect(view.textContent).toContain('2 von 3')
  })

  it('chooses several, shows what is used in the question, and removes the deleted ones from the page and the storage line', async () => {
    await show()
    await act(async () => button('Auswählen')!.click())
    await act(async () => tile(2).querySelector('button')!.click())
    await act(async () => tile(3).querySelector('button')!.click())
    expect(tile(2).querySelector('button')!.className).toContain('ring-accent')
    // A tap while choosing does not open the big view.
    expect(document.querySelector('[data-lightbox]')).toBeNull()
    storage = { used: 1000, limit: 5 * 1024 ** 3, count: 3 }
    await act(async () => button('2 Fotos löschen')!.click())
    const question = await until(() => document.querySelector<HTMLElement>('[role=dialog]'), 'the question')
    expect(question.textContent).toContain('Eines davon wird noch verwendet')
    await act(async () => [...question.querySelectorAll('button')].find((item) => item.textContent === '2 Fotos löschen')!.click())
    await eventually(() => expect(tiles().map((item) => item.getAttribute('data-photo'))).toEqual([id(1)]), 'the photos going')
    expect(calls.find((call) => call.url === '/api/photos/delete')!.body).toEqual({ ids: [id(2), id(3)] })
    await eventually(() => expect(box.querySelector('[data-testid="storage"]')!.textContent).toContain('3 Fotos'), 'the storage line')
  })
})
