/**
 * The journal: a blog or a timeline as the account chose, the next page when asked, a tag as a filter, the search in
 * the body of a request (never in the address) with its hits marked, hostile titles as text. And one own day read, its
 * share dialog sending exactly whom and what.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import type { JournalDay, Profile } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { EntryPage } from './EntryPage'
import { JournalPage, searchEntries } from './JournalPage'
import { idle, until } from '../test/wait'

const me: { profile: Partial<Profile> } = { profile: { journal: 'blog', timezone: 'Europe/Berlin' } }
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))

function day(date: string, title: string, extra: Partial<JournalDay> = {}): JournalDay {
  return { date, title, excerpt: `Text von ${title}`, tags: ['familie'], cover: 'illu:baum.abend.herbst', written_by: 'self', first_value: { name: 'Stimmung', value: 7 }, shared_with: [], unreadable: false, ...extra }
}

const FIRST = [day('2026-10-05', 'Zu viel auf einmal'), day('2026-10-04', 'Sonntag <img src=x onerror="window.__xss=1">', { written_by: 'ai', shared_with: [{ id: 2, name: 'tom', display_name: 'Tom', avatar: null, with_values: false, with_notes: false, heart: null }] }), day('2026-09-30', 'Ende September')]
const SECOND = [day('2026-09-20', 'Weiter zurück')]

type Call = { method: string; url: string; body: unknown }
let calls: Call[] = []
/** What the server finds as the newest day before the one a year back (a year-ago request has a limit of one). */
let yearAgoOf: JournalDay | null = null
/** The cover of 4 October is a photo that came with a note. */
let coverOnNote = false
const NOTE_PHOTO = 'd'.repeat(32)
const DAY_PHOTO = 'e'.repeat(32)
/** The text of 4 October holds a picture of the photo of the day; Immich is connected. */
let photoInText = false
let immichOn = false
const COLLECTION = 'a1a1a1a1-0000-4000-8000-000000000001'
const TAKEN = '7'.repeat(32)

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
      if (address.pathname === '/api/journal/overview') return json({ count: 4, since: '2026-05-04', tags: [{ tag: 'familie', count: 3 }, { tag: 'see', count: 1 }] })
      if (address.pathname === '/api/journal' && method === 'POST') {
        if (body.tag) return json({ days: [FIRST[1]], more: false })
        if (body.before === '2026-09-30') return json({ days: SECOND, more: false })
        if (body.limit === 1) return json({ days: yearAgoOf ? [yearAgoOf] : [], more: false })
        return json({ days: FIRST, more: true })
      }
      if (url === '/api/search') return json({ results: [{ date: '2026-10-06', kind: 'note', snippet: 'mit mia kastanien gesammelt' }, { date: '2026-10-04', kind: 'text', snippet: '… am See kastanien …' }], more: false, days: { '2026-10-04': FIRST[1] } })
      // The days of the leap year 2028: a plain page each.
      if (/^\/api\/days\/2028-\d\d-\d\d$/.test(url)) return json({ date: url.slice(-10), title: 'Schaltjahr', text: 'Text', tags: [], values: {}, cover: 'illu:baum.abend.herbst', cover_chosen: false, written_by: 'self', words: 1, revision: 0, created_at: '', updated_at: '' })
      if (/^\/api\/days\/2028-\d\d-\d\d\/shares$/.test(url) && method === 'GET') return json({ date: url.slice(10, 20), people: [], with_values: false, with_notes: false })
      if (url === '/api/immich') return json(immichOn ? { allowed: true, connected: true, url: 'http://x', key_set: true, suggest: true } : { allowed: false, connected: false })
      if (url.startsWith('/api/immich/timeline')) return json({ photos: [{ id: COLLECTION, taken_at: '2024-05-01T10:00:00+00:00' }], next: null })
      if (url === '/api/immich/albums') return json({ available: true, albums: [] })
      if (url.startsWith('/api/immich/photos?')) return json({ date: '2026-10-04', photos: [], more: false })
      if (url === `/api/immich/photos/${COLLECTION}` && method === 'POST') return json({ id: TAKEN, date: '2026-10-04', source: 'immich', width: 4, height: 3, created_at: '', on_note: false }, 201)
      if (url === '/api/days/2026-10-04' && method === 'PUT') return json({ date: '2026-10-04', title: 'Sonntag', text: 'Am **See**.', tags: ['familie'], values: {}, cover: body.cover, cover_chosen: true, written_by: 'ai', words: 2, revision: 1, created_at: '', updated_at: '' })
      if (url === '/api/days/2026-10-04') return json({ date: '2026-10-04', title: 'Sonntag', text: photoInText ? `Am **See**.\n\n![Der See](photo:${DAY_PHOTO})\n\nSpäter.` : 'Am **See**.', tags: ['familie'], values: { v1: 9 }, cover: coverOnNote ? `photo:${NOTE_PHOTO}` : 'illu:baum.abend.herbst', cover_chosen: false, written_by: 'ai', words: 2, revision: 0, created_at: '', updated_at: '' })
      if (url === '/api/notes?date=2026-10-04') return json([{ id: 'n1', date: '2026-10-04', text: 'see! wasser kalt', unreadable: false, prompt: null, photo_id: null, created_at: '2026-10-04T10:00:00+00:00', updated_at: null }])
      if (url === '/api/photos?date=2026-10-04' && photoInText && !coverOnNote) return json([{ id: DAY_PHOTO, date: '2026-10-04', source: 'upload', width: 4, height: 3, created_at: '', on_note: false }, { id: '9'.repeat(32), date: '2026-10-04', source: 'upload', width: 4, height: 3, created_at: '', on_note: false }])
      if (url === '/api/photos?date=2026-10-04')
        return json(
          coverOnNote
            ? [
                { id: NOTE_PHOTO, date: '2026-10-04', source: 'upload', width: 4, height: 3, created_at: '', on_note: true },
                { id: 'f'.repeat(32), date: '2026-10-04', source: 'upload', width: 4, height: 3, created_at: '', on_note: true },
                { id: DAY_PHOTO, date: '2026-10-04', source: 'upload', width: 4, height: 3, created_at: '', on_note: false },
              ]
            : [],
        )
      if (url === '/api/values') return json([{ id: 'v1', name: 'Stimmung', low: 'mies', high: 'super', hint: '', active: true, position: 0 }])
      if (url === '/api/days/2026-10-04/shares' && method === 'GET') return json({ date: '2026-10-04', people: [{ id: 2, name: 'tom', display_name: 'Tom', avatar: null, with_values: false, with_notes: false, heart: '2026-10-05T08:00:00+00:00' }], with_values: false, with_notes: false })
      if (url === '/api/days/2026-10-04/shares' && method === 'PUT') return json({ date: '2026-10-04', people: [], with_values: body.with_values, with_notes: body.with_notes })
      if (url === '/api/people') return json([{ id: 2, name: 'tom', display_name: 'Tom', avatar: null }, { id: 3, name: 'mia', display_name: 'Mia', avatar: null }])
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function show(path: string): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tagebuch" element={<JournalPage />} />
          <Route path="/tag/:date" element={<EntryPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await idle()
}


async function click(element: Element | null | undefined): Promise<void> {
  await act(async () => (element as HTMLElement).click())
  await idle()
}

beforeAll(async () => {
  await changeLanguage('de')
})

beforeEach(() => {
  coverOnNote = false
  photoInText = false
  immichOn = false
  yearAgoOf = null
  me.profile = { journal: 'blog', timezone: 'Europe/Berlin' }
  serve()
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete (window as { __xss?: number }).__xss
})

describe('the journal', () => {
  it('shows a blog, the newest day large, and goes on with the next page', async () => {
    await show('/tagebuch')
    expect(box.textContent).toContain('4 Tage aufgeschrieben, seit Mai 2026.')
    const titles = () => [...box.querySelectorAll('h2, h3')].map((heading) => heading.textContent)
    expect(titles()).toEqual(['Zu viel auf einmal', FIRST[1].title, 'Ende September'])
    expect(box.querySelectorAll('img[src="x"]')).toHaveLength(0)
    expect(box.textContent).toContain('geteilt')
    expect(box.querySelector('a[href="/tag/2026-10-05"]')).not.toBeNull()
    await click([...box.querySelectorAll('button')].find((button) => button.textContent === 'Mehr laden'))
    expect(titles()).toEqual(['Zu viel auf einmal', FIRST[1].title, 'Ende September', 'Weiter zurück'])
    expect(calls.some((call) => call.url === '/api/journal' && (call.body as { before?: string }).before === '2026-09-30')).toBe(true)
    expect([...box.querySelectorAll('button')].some((button) => button.textContent === 'Mehr laden')).toBe(false)
    expect((window as { __xss?: number }).__xss).toBeUndefined()
  })

  it('shows a timeline grouped by month', async () => {
    me.profile = { ...me.profile, journal: 'timeline' }
    await show('/tagebuch')
    expect([...box.querySelectorAll('section > h2')].map((heading) => heading.textContent)).toEqual(['Oktober 2026', 'September 2026'])
    expect(box.querySelectorAll('section a')).toHaveLength(3)
    expect(box.textContent).toContain('#familie')
  })

  it('filters by a tag through the server', async () => {
    await show('/tagebuch')
    await click([...box.querySelectorAll('button')].find((button) => button.textContent?.startsWith('see')))
    expect(calls.some((call) => call.url === '/api/journal' && (call.body as { tag?: string }).tag === 'see')).toBe(true)
    expect(calls.every((call) => !call.url.includes('see'))).toBe(true)
    expect([...box.querySelectorAll('h2, h3')].map((heading) => heading.textContent)).toEqual([FIRST[1].title])
  })

  it('searches in the body, never in the address, once typing rests', async () => {
    await show('/tagebuch')
    const input = box.querySelector<HTMLInputElement>('input[type=search]')!
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      for (const text of ['k', 'ka', 'kastanien']) {
        set.call(input, text)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
    })
    // The search goes out when the typing rests: that request is the event waited for.
    await until(() => calls.some((call) => call.url.startsWith('/api/search')), 'the search')
    await idle()
    const searches = calls.filter((call) => call.url.startsWith('/api/search'))
    expect(searches).toEqual([{ method: 'POST', url: '/api/search', body: { q: 'kastanien' } }])
    expect(calls.every((call) => !call.url.includes('kastanien'))).toBe(true)
    expect(box.textContent).toContain('2 Treffer')
    expect(box.querySelector('mark')?.textContent).toBe('kastanien')
    expect(box.querySelector('a[href="/tag/2026-10-06/schreiben"]')?.textContent).toContain('Nur Notizen, noch keine Seite')
  })

  it('puts the hits of a search in the order of their days, a page once', () => {
    const entries = searchEntries({ results: [{ date: '2026-10-04', kind: 'title', snippet: 'Sonntag' }, { date: '2026-10-04', kind: 'note', snippet: 'notiz' }, { date: '2026-10-01', kind: 'note', snippet: 'nur notiz' }], more: false, days: { '2026-10-04': FIRST[1] } })
    expect(entries.map((entry) => [entry.date, entry.excerpt, entry.onlyNotes ?? false])).toEqual([
      ['2026-10-04', FIRST[1].excerpt, false],
      ['2026-10-01', 'nur notiz', true],
    ])
  })
})

describe('a day read', () => {
  it('shows the page, its values, the heart of whom it is shared with, and the notes folded away', async () => {
    await show('/tag/2026-10-04')
    expect(box.querySelector('h1')?.textContent).toBe('Sonntag')
    expect(box.querySelector('.prose-diary strong')?.textContent).toBe('See')
    expect(box.textContent).toContain('Stimmung')
    expect(box.textContent).toContain('9/10')
    expect(box.querySelector('[aria-label="Tom hat ein Herz geschickt"]')).not.toBeNull()
    expect(box.textContent).not.toContain('see! wasser kalt')
    await click(box.querySelector('button[aria-expanded]'))
    expect(box.textContent).toContain('see! wasser kalt')
    expect(box.querySelector('a[href="/tag/2026-10-04/schreiben"]')?.textContent).toContain('Bearbeiten')
  })

  it('offers the same calendar day a year back, also after a leap day, and only if it is that very day', async () => {
    yearAgoOf = day('2027-03-01', 'Vor einem Jahr')
    await show('/tag/2028-03-01')
    expect(calls.find((call) => call.url === '/api/journal' && (call.body as { limit?: number }).limit === 1)?.body).toMatchObject({ before: '2027-03-02' })
    expect(box.querySelector('a[href="/tag/2027-03-01"]')?.textContent).toContain('Vor einem Jahr')
    act(() => root.unmount())
    box.remove()
    // 29 February is met by 28 February; a newer day than that is no year-ago day.
    yearAgoOf = day('2027-02-28', 'Am 28.')
    await show('/tag/2028-02-29')
    expect(box.querySelector('a[href="/tag/2027-02-28"]')).not.toBeNull()
    act(() => root.unmount())
    box.remove()
    yearAgoOf = day('2027-02-20', 'Zu früh')
    await show('/tag/2028-02-29')
    expect(box.querySelector('a[href="/tag/2027-02-20"]')).toBeNull()
  })

  it('shares with exactly whom was chosen, and what', async () => {
    await show('/tag/2026-10-04')
    await click([...box.querySelectorAll('button')].find((button) => button.textContent?.includes('Teilen')))
    const dialog = box.querySelector('[role=dialog]')!
    expect(dialog.textContent).toContain('Diesen Tag teilen')
    const person = (name: string) => [...dialog.querySelectorAll('button[aria-pressed]')].find((button) => button.textContent?.includes(name))!
    expect(person('Tom').getAttribute('aria-pressed')).toBe('true')
    expect(dialog.textContent).toContain('Was sieht Tom?')
    await click(person('Mia'))
    expect(dialog.textContent).toContain('Was sieht die Familie?')
    await click(person('Tom'))
    await click(dialog.querySelector('[aria-label="Notizen mit teilen"]'))
    await click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Teilen'))
    const put = calls.find((call) => call.method === 'PUT' && call.url === '/api/days/2026-10-04/shares')
    expect(put?.body).toEqual({ to: [3], with_values: false, with_notes: true })
    expect(box.querySelector('[role=dialog]')).toBeNull()
  })

  it('says in the dialog when the cover comes from the notes, and lists no photo of a note among those of the day', async () => {
    coverOnNote = true
    await show('/tag/2026-10-04')
    const grid = [...box.querySelectorAll('article img')].map((image) => image.getAttribute('src'))
    // A photo of the day stands large, from the original, in the shape it has.
    expect(grid).toContain(`/api/photos/${DAY_PHOTO}`)
    expect(grid.some((src) => src?.includes('f'.repeat(32)))).toBe(false)
    await click([...box.querySelectorAll('button')].find((button) => button.textContent?.includes('Teilen')))
    expect(box.querySelector('[role=dialog]')?.textContent).toContain('Das Titelbild ist ein Foto aus deinen Notizen und wird mitgezeigt.')
  })

  it('shows a photo that stands in the text inside the text and not a second time among the photos of the day', async () => {
    photoInText = true
    await show('/tag/2026-10-04')
    const figure = box.querySelector('figure.diary-photo')!
    expect(figure.querySelector('img')?.getAttribute('src')).toBe(`/api/photos/${DAY_PHOTO}`)
    expect(figure.querySelector('figcaption')?.textContent).toBe('Der See')
    const grid = [...box.querySelectorAll('article img')].map((image) => image.getAttribute('src'))
    expect(grid.filter((src) => src?.includes(DAY_PHOTO))).toEqual([`/api/photos/${DAY_PHOTO}`])
    expect(grid).toContain(`/api/photos/${'9'.repeat(32)}`)
  })

  it('picks a cover from the whole collection of Immich: the photo becomes one of the day and its cover', async () => {
    immichOn = true
    await show('/tag/2026-10-04')
    await click([...box.querySelectorAll('button')].find((button) => button.textContent?.includes('Titelbild ändern')))
    await click([...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Weitere aus Immich')))
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('Aus Immich wählen')
    await click(document.querySelector('[data-immich-tiles] button:has(img)'))
    expect(calls.find((call) => call.method === 'POST' && call.url === `/api/immich/photos/${COLLECTION}`)?.body).toEqual({ date: '2026-10-04', anywhen: true })
    expect(calls.filter((call) => call.method === 'PUT' && call.url === '/api/days/2026-10-04').map((call) => call.body)).toEqual([{ cover: `photo:${TAKEN}` }])
    expect(document.querySelector('[role=dialog]')).toBeNull()
  })

  it('offers no way into the collection where there is no Immich', async () => {
    await show('/tag/2026-10-04')
    await click([...box.querySelectorAll('button')].find((button) => button.textContent?.includes('Titelbild ändern')))
    expect([...document.querySelectorAll('button')].some((button) => button.textContent?.includes('Weitere aus Immich'))).toBe(false)
  })

  it('says nothing of the kind for an illustration', async () => {
    await show('/tag/2026-10-04')
    await click([...box.querySelectorAll('button')].find((button) => button.textContent?.includes('Teilen')))
    expect(box.querySelector('[role=dialog]')?.textContent).not.toContain('Titelbild ist ein Foto')
  })

  it('ends sharing when nobody is chosen', async () => {
    await show('/tag/2026-10-04')
    await click([...box.querySelectorAll('button')].find((button) => button.textContent?.includes('Teilen')))
    const dialog = box.querySelector('[role=dialog]')!
    await click([...dialog.querySelectorAll('button[aria-pressed]')].find((button) => button.textContent?.includes('Tom')))
    const end = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Teilen beenden')
    expect(end).toBeDefined()
    await click(end)
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({ to: [], with_values: false, with_notes: false })
  })
})
