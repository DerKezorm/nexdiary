/**
 * The cut of a cover photo, everywhere the cover stands: the reading page and the writing page (where it is chosen),
 * the cards of the journal as a blog and as a timeline, a year ago, the shared days and the statistics. Every frame,
 * whatever its shape, holds on to the same point of the photo; a frame without a cut stays as it always was. Chosen,
 * it goes to the server with its cover, and a new cover starts without one.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import type { JournalDay, Profile, Stats } from '../api/client'
import { YearAgo } from '../components/YearAgo'
import { CoverImage } from '../covers/Cover'
import '../i18n'
import { changeLanguage } from '../i18n'
import { idle, until } from '../test/wait'
import { EntryPage } from './EntryPage'
import { JournalPage } from './JournalPage'
import { SharedEntryPage, SharedPage } from './SharedPage'
import { StatsPage } from './StatsPage'
import WritePage from './WritePage'

const me: { profile: Partial<Profile> } = { profile: { journal: 'blog', timezone: 'Europe/Berlin' } }
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))
const refresh = vi.fn()
vi.mock('../state/shared', () => ({ useShared: () => ({ unseen: 0, refresh }) }))

const DATE = '2026-10-04'
const PHOTO = 'c'.repeat(32)
const SECOND = 'd'.repeat(32)
const COVER = `photo:${PHOTO}`
const CROP = { x: 250, y: 700, zoom: 150 }
/** What a frame with this cut is styled with: the point held, the zoom around it. */
const STYLED = ['25% 70%', 'scale(1.5)', '25% 70%']

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let day: Record<string, unknown>
let draft: Record<string, unknown> | null = null

function journalDay(date: string, extra: Partial<JournalDay> = {}): JournalDay {
  return { date, title: `Tag ${date}`, excerpt: 'Text', tags: [], cover: COVER, cover_crop: CROP, written_by: 'self', first_value: null, shared_with: [], unreadable: false, ...extra }
}

function stats(): Stats {
  const none = { count: 0, best: null, worst: null }
  return {
    today: '2026-10-06',
    pages: 2,
    unreadable: 0,
    value: { id: 'v1', name: 'Laune', low: 'mies', high: 'super' },
    values: [{ id: 'v1', name: 'Laune', low: 'mies', high: 'super' }],
    tiles: { current: 1, longest: 1, longest_end: null, today_done: false, year: 2026, days_year: 2, days_total: 2, words: 10, words_per_day: 5 },
    calendar: { start: '2026-04-13', weeks: 26, days: [] },
    series: { days: 180, end: '2026-10-06', values: {} },
    weekdays: { days: Array.from({ length: 7 }, () => ({ n: 0, mean: null })), best: null },
    together: [],
    tags: [],
    extremes: {
      '30': none,
      '365': { count: 2, best: { date: '2026-10-05', title: 'Der Gute', excerpt: '', cover: COVER, cover_crop: CROP, value: 9 }, worst: { date: DATE, title: 'Der Schlimme', excerpt: '', cover: COVER, value: 2 } },
      all: none,
    },
    writing: { total: 2, ai: 0, self: 2, photos: 1, shared: 0 },
    year_ago: { date: '2025-10-06', title: 'Vor einem Jahr', excerpt: '', cover: COVER, cover_crop: CROP },
  } as Stats
}

function page(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { date: DATE, title: 'Sonntag', text: 'Am See.', tags: [], values: {}, cover: COVER, cover_chosen: true, cover_crop: CROP, written_by: 'self', words: 2, revision: 3, created_at: '', updated_at: '2026-10-04T17:00:00+00:00', ...extra }
}

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === `/api/days/${DATE}/draft`) {
        if (method === 'PUT') draft = { ...body, updated_at: '2026-10-04T18:00:00+00:00' }
        if (method === 'DELETE') draft = null
        return method === 'DELETE' ? new Response(null, { status: 204 }) : json(draft)
      }
      if (url === `/api/days/${DATE}` && method === 'PUT') {
        const { base_revision: _base, ...fields } = body!
        // As the server does: another cover without a cut has none; the same cover without one keeps its cut.
        const crop = 'cover_crop' in fields ? fields.cover_crop : 'cover' in fields && fields.cover !== day.cover ? null : day.cover_crop
        day = { ...day, ...fields, cover_chosen: true, cover_crop: crop, revision: Number(day.revision) + 1 }
        return json(day)
      }
      if (url === `/api/days/${DATE}`) return json(day)
      if (url === `/api/days/${DATE}/shares`) return json({ date: DATE, people: [], with_values: false, with_notes: false })
      if (url.startsWith('/api/photos?'))
        return json([
          { id: PHOTO, date: DATE, source: 'upload', width: 400, height: 400, created_at: '', on_note: false },
          { id: SECOND, date: DATE, source: 'upload', width: 400, height: 300, created_at: '', on_note: false },
        ])
      if (url === '/api/journal/overview') return json({ count: 2, since: DATE, tags: [] })
      if (url === '/api/journal') return json({ days: body?.limit === 1 ? [] : [journalDay('2026-10-05'), journalDay(DATE), journalDay('2026-10-03', { cover_crop: null })], more: false })
      if (url === '/api/shared') return json([{ from: { id: 7, name: 'tom', display_name: 'Tom', avatar: null }, date: DATE, title: 'Geteilt', excerpt: '', cover: COVER, cover_crop: CROP, new: false, heart: null }])
      if (url === '/api/shares') return json([{ date: DATE, title: 'Von mir', cover: COVER, cover_crop: CROP, unreadable: false, people: [] }])
      if (url === `/api/shared/7/${DATE}`)
        return json({ from: { id: 7, name: 'tom', display_name: 'Tom', avatar: null }, date: DATE, title: 'Geteilt', text: 'Text', tags: [], cover: COVER, cover_crop: CROP, photos: [], with_values: false, with_notes: false, heart: null, shared_at: '' })
      if (url === '/api/stats') return json(stats())
      if (url === '/api/values') return json([])
      return json([])
    }),
  )
}

let root: Root | null = null
let box: HTMLDivElement | null = null

async function show(path: string, element: React.ReactNode = null): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tagebuch" element={<JournalPage />} />
          <Route path="/tag/:date" element={<EntryPage />} />
          <Route path="/tag/:date/schreiben" element={<WritePage />} />
          <Route path="/geteilt" element={<SharedPage />} />
          <Route path="/geteilt/:from/:date" element={<SharedEntryPage />} />
          <Route path="/statistik" element={<StatsPage />} />
          <Route path="/" element={element} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await idle()
}

/** The cut pictures of the cover photo: their style, as numbers made it. */
function framed(scope: ParentNode = box!): string[][] {
  return [...scope.querySelectorAll<HTMLElement>('[data-cover-crop] img')].map((img) => [img.style.objectPosition, img.style.transform, img.style.transformOrigin])
}

function button(name: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name)!
}

function key(element: Element, name: string): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }))
  })
}

function place(element: Element, width: number, height: number): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width, height, right: width, bottom: height, toJSON: () => ({}) } as DOMRect)
}

beforeAll(async () => {
  await changeLanguage('de')
})

beforeEach(() => {
  day = page()
  draft = null
  me.profile.journal = 'blog'
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  root = box = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the cut of a cover where it shows', () => {
  it('is the same point in every frame, and a frame without a cut stays as it was', () => {
    const out = document.createElement('div')
    document.body.appendChild(out)
    const here = createRoot(out)
    act(() =>
      here.render(
        <>
          <CoverImage cover={COVER} crop={CROP} large className="aspect-[16/8] w-full rounded-xl" />
          <CoverImage cover={COVER} crop={CROP} className="h-14 w-20" />
          <CoverImage cover={COVER} crop={null} className="h-14 w-20" />
          <CoverImage cover={COVER} crop={{ x: 500, y: 500, zoom: 100 }} className="h-14 w-20" />
          <CoverImage cover="illu:baum.abend.herbst" crop={CROP} className="h-14 w-20" />
          <CoverImage cover={COVER} crop={{ x: 'url(x)', y: 1, zoom: 100 } as never} className="h-14 w-20" />
        </>,
      ),
    )
    expect(framed(out)).toEqual([STYLED, STYLED])
    // The frame keeps the classes of the place (shape, corners), the picture fills it.
    const frames = out.querySelectorAll<HTMLElement>('[data-cover-crop]')
    expect(frames[0].className).toContain('aspect-[16/8]')
    expect(frames[0].className).toContain('overflow-hidden')
    expect(frames[0].querySelector('img')!.getAttribute('src')).toBe(`/api/photos/${PHOTO}`)
    expect(frames[1].querySelector('img')!.getAttribute('src')).toBe(`/api/photos/${PHOTO}/preview`)
    // Without a cut, the middle, an illustration, or something that is no cut: the picture as always.
    const plain = [...out.querySelectorAll<HTMLImageElement>('img')].filter((img) => !img.closest('[data-cover-crop]'))
    expect(plain).toHaveLength(3)
    for (const img of plain) {
      expect(img.getAttribute('style')).toBeNull()
      expect(img.className).toContain('object-cover h-14 w-20')
    }
    act(() => here.unmount())
    out.remove()
  })

  it('on the reading page', async () => {
    await show(`/tag/${DATE}`)
    expect(framed()).toEqual([STYLED])
  })

  it('on the cards of the journal, as a blog and as a timeline', async () => {
    await show('/tagebuch')
    expect(framed()).toEqual([STYLED, STYLED])
    act(() => root!.unmount())
    box!.remove()
    me.profile.journal = 'timeline'
    await show('/tagebuch')
    expect(framed().length).toBe(2)
    expect(framed().every((style) => JSON.stringify(style) === JSON.stringify(STYLED))).toBe(true)
  })

  it('a year ago', async () => {
    await show('/', <YearAgo day={{ date: '2025-10-04', title: 'Vor einem Jahr', cover: COVER, cover_crop: CROP }} />)
    expect(framed()).toEqual([STYLED])
  })

  it('on the shared days, both lists and the day itself', async () => {
    await show('/geteilt')
    // Shared with me (through the share), and shared by me.
    expect(framed()).toEqual([STYLED])
    expect(box!.querySelector('[data-cover-crop] img')!.getAttribute('src')).toBe(`/api/shared/7/${DATE}/photos/${PHOTO}/preview`)
    act(() => root!.unmount())
    box!.remove()
    await show('/geteilt?tab=von-mir')
    expect(framed()).toEqual([STYLED])
    expect(box!.querySelector('[data-cover-crop] img')!.getAttribute('src')).toBe(`/api/photos/${PHOTO}/preview`)
    act(() => root!.unmount())
    box!.remove()
    await show(`/geteilt/7/${DATE}`)
    expect(framed()).toEqual([STYLED])
    expect(box!.querySelector('[data-cover-crop] img')!.getAttribute('src')).toBe(`/api/shared/7/${DATE}/photos/${PHOTO}`)
  })

  it('on the statistics: the best day and a year ago', async () => {
    // A year is the span shown first: its best day has a cut, its worst none.
    await show('/statistik')
    expect(framed()).toEqual([STYLED, STYLED])
  })

  it('on the writing page, as the server keeps it', async () => {
    await show(`/tag/${DATE}/schreiben`)
    await until(() => box!.querySelector('[data-cover-crop]'), 'the cover')
    expect(framed()).toEqual([STYLED])
  })
})

describe('choosing the cut of a cover', () => {
  it('on the reading page: opened from the cover, sent with the cover, back to none with "Zurücksetzen"', async () => {
    await show(`/tag/${DATE}`)
    await act(async () => button('Ausschnitt').click())
    const frame = await until(() => document.querySelector<HTMLElement>('[data-cover-crop-frame]'), 'the dialog')
    // The smaller copy, the cut as it stands.
    expect(frame.querySelector('img')!.getAttribute('src')).toBe(`/api/photos/${PHOTO}/preview`)
    expect(frame.querySelector('img')!.style.transform).toBe('scale(1.5)')
    place(frame, 400, 200)
    key(frame, '+')
    await act(async () => button('Fertig').click())
    await idle()
    const put = calls.filter((call) => call.method === 'PUT' && call.url === `/api/days/${DATE}`)
    expect(put).toHaveLength(1)
    expect(put[0].body).toMatchObject({ cover: COVER, cover_crop: { zoom: 165 } })
    expect(framed()[0][1]).toBe('scale(1.65)')
    await act(async () => button('Ausschnitt').click())
    await act(async () => button('Zurücksetzen').click())
    await act(async () => button('Fertig').click())
    await idle()
    const last = calls.filter((call) => call.method === 'PUT').at(-1)!
    expect(last.body).toEqual({ cover: COVER, cover_crop: null })
    expect(box!.querySelector('[data-cover-crop]')).toBeNull()
  })

  it('on the reading page: also from the cover picker, and only for a photo', async () => {
    await show(`/tag/${DATE}`)
    await act(async () => button('Titelbild ändern').click())
    await act(async () => button('Ausschnitt anpassen').click())
    expect(document.querySelector('[data-cover-crop-frame]')).not.toBeNull()
    await act(async () => button('Abbrechen').click())
    expect(calls.some((call) => call.method === 'PUT')).toBe(false)
    act(() => root!.unmount())
    box!.remove()
    day = page({ cover: 'illu:baum.abend.herbst', cover_crop: null })
    await show(`/tag/${DATE}`)
    expect(button('Ausschnitt')).toBeUndefined()
    await act(async () => button('Titelbild ändern').click())
    expect(button('Ausschnitt anpassen')).toBeUndefined()
  })

  it('on the writing page: kept in the draft, saved with the cover, gone with another cover', async () => {
    day = page({ cover_crop: null })
    await show(`/tag/${DATE}/schreiben`)
    await until(() => button('Ausschnitt'), 'the button')
    await act(async () => button('Ausschnitt').click())
    const frame = await until(() => document.querySelector<HTMLElement>('[data-cover-crop-frame]'), 'the dialog')
    place(frame, 400, 200)
    key(frame, '+')
    key(frame, 'ArrowUp')
    await act(async () => button('Fertig').click())
    const shown = framed()
    expect(shown).toHaveLength(1)
    expect(shown[0][1]).toBe('scale(1.1)')
    // The draft keeps it.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await idle()
    const kept = calls.filter((call) => call.method === 'PUT' && call.url.endsWith('/draft')).at(-1)!
    expect(kept.body).toMatchObject({ cover: COVER, cover_crop: { zoom: 110 } })
    expect((kept.body!.cover_crop as { y: number }).y).toBeGreaterThan(500)
    // Saved with its cover.
    await act(async () => button('Speichern').click())
    await idle()
    const saved = calls.filter((call) => call.method === 'PUT' && call.url === `/api/days/${DATE}`).at(-1)!
    expect(saved.body).toMatchObject({ cover: COVER, cover_crop: { zoom: 110 } })
  })

  it('on the writing page: "Zurücksetzen" takes the cut away on the server too', async () => {
    await show(`/tag/${DATE}/schreiben`)
    await until(() => box!.querySelector('[data-cover-crop]'), 'the cover')
    await act(async () => button('Ausschnitt').click())
    await act(async () => button('Zurücksetzen').click())
    await act(async () => button('Fertig').click())
    expect(box!.querySelector('[data-cover-crop]')).toBeNull()
    await act(async () => button('Speichern').click())
    await idle()
    const saved = calls.filter((call) => call.method === 'PUT' && call.url === `/api/days/${DATE}`).at(-1)!
    expect(saved.body).toMatchObject({ cover: COVER, cover_crop: null })
    expect(day.cover_crop).toBeNull()
  })

  it('on the reading page: the same photo chosen again starts without a cut', async () => {
    await show(`/tag/${DATE}`)
    await act(async () => button('Titelbild ändern').click())
    await act(async () => button('Eigenes Foto').click())
    await idle()
    const last = calls.filter((call) => call.method === 'PUT').at(-1)!
    expect(last.body).toEqual({ cover: COVER, cover_crop: null })
    expect(box!.querySelector('[data-cover-crop]')).toBeNull()
  })

  it('on the writing page: another photo starts without a cut', async () => {
    await show(`/tag/${DATE}/schreiben`)
    await until(() => box!.querySelector('[data-cover-crop]'), 'the cover')
    await act(async () => button('Titelbild ändern').click())
    const other = [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button[title="Eigenes Foto"]')].find((item) => item.querySelector(`img[src*="${SECOND}"]`))!
    await act(async () => other.click())
    // The new photo is shown whole, and the button for its cut is there.
    expect(box!.querySelector('[data-cover-crop]')).toBeNull()
    expect(box!.querySelector(`img[src="/api/photos/${SECOND}"]`)).not.toBeNull()
    expect(button('Ausschnitt')).toBeDefined()
    await act(async () => button('Speichern').click())
    await idle()
    const saved = calls.filter((call) => call.method === 'PUT' && call.url === `/api/days/${DATE}`).at(-1)!
    expect(saved.body!.cover).toBe(`photo:${SECOND}`)
    expect(saved.body).not.toHaveProperty('cover_crop')
    expect(day.cover_crop).toBeNull()
  })

  it('on the writing page: an illustration starts without a cut', async () => {
    await show(`/tag/${DATE}/schreiben`)
    await until(() => box!.querySelector('[data-cover-crop]'), 'the cover')
    await act(async () => button('Titelbild ändern').click())
    const illustration = await until(() => document.querySelector<HTMLButtonElement>('[role=dialog] [aria-pressed=false][title]:not([title="Eigenes Foto"])'), 'an illustration')
    await act(async () => illustration.click())
    expect(box!.querySelector('[data-cover-crop]')).toBeNull()
    expect(button('Ausschnitt')).toBeUndefined()
    await act(async () => button('Speichern').click())
    await idle()
    const saved = calls.filter((call) => call.method === 'PUT' && call.url === `/api/days/${DATE}`).at(-1)!
    expect(saved.body!.cover).toMatch(/^illu:/)
    expect(saved.body).not.toHaveProperty('cover_crop')
  })
})
