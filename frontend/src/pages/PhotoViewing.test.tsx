/**
 * Photos on the pages around them: a large photo keeps the shape it has and opens in the big view when tapped (the day
 * read, a shared day), small tiles open it too, and the menu offers "Fotos" from the first photo on.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { AppShell } from '../components/AppShell'
import { LightboxProvider } from '../components/Lightbox'
import { PhotoDeleteProvider } from '../components/PhotoDelete'
import '../i18n'
import { changeLanguage } from '../i18n'
import { idle, until } from '../test/wait'
import { EntryPage } from './EntryPage'
import { SharedEntryPage } from './SharedPage'

const me = {
  id: 1, name: 'jule', display_name: 'Jule', role: 'operator', avatar: null, version: '0.1.0', whats_new_seen: '0.1.0',
  profile: { palette: 'salbei', mode: 'light', layout: 'page', quick_start: false, journal: 'blog', timezone: 'Europe/Berlin' },
}
vi.mock('../state/auth', () => ({ useAuth: () => ({ me, refresh: async () => undefined, signOut: async () => undefined }) }))

const COVER = 'c'.repeat(32)
const WIDE = 'a'.repeat(32)
const TALL = 'b'.repeat(32)
const NOTE = 'd'.repeat(32)
let photoCount = 0
let root: Root
let box: HTMLDivElement

function serve(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
      const photo = (id: string, width: number, height: number, onNote = false) => ({ id, date: '2026-10-04', source: 'upload', width, height, created_at: '', on_note: onNote })
      if (url === '/api/photos/storage') return json({ used: 10, limit: null, count: photoCount })
      if (url === '/api/shared/count') return json({ new: 0 })
      if (url === '/api/capsules/count') return json({ new: 0 })
      if (url === '/api/journal') return json({ days: [], more: false })
      if (url === '/api/days/2026-10-04') return json({ date: '2026-10-04', title: 'Sonntag', text: 'Am See.', tags: [], values: {}, cover: `photo:${COVER}`, cover_chosen: true, written_by: 'self', words: 2, revision: 0, created_at: '', updated_at: '' })
      if (url === '/api/notes?date=2026-10-04') return json([{ id: 'n1', date: '2026-10-04', text: 'see', unreadable: false, prompt: null, photo_id: NOTE, created_at: '2026-10-04T10:00:00+00:00', updated_at: null }])
      if (url === '/api/photos?date=2026-10-04') return json([photo(COVER, 4000, 3000), photo(WIDE, 4000, 1000), photo(TALL, 1000, 4000), photo(NOTE, 4, 3, true)])
      if (url === '/api/values') return json([])
      if (url === '/api/days/2026-10-04/shares') return json({ date: '2026-10-04', people: [], with_values: false, with_notes: false })
      if (url === '/api/shared/7/2026-10-04') return json({ from: { id: 7, name: 'tom', display_name: 'Tom', avatar: null }, date: '2026-10-04', title: 'Von Tom', text: 'Ein Tag.', tags: [], cover: `photo:${COVER}`, photos: [{ id: WIDE, width: 4000, height: 1000 }, { id: TALL, width: 1000, height: 4000 }], heart: null, values: null, notes: null })
      if (url.startsWith('/api/shared/7/')) return json({})
      return json([])
    }),
  )
}

async function show(element: React.ReactNode, at: string): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  box.id = 'root'
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <PhotoDeleteProvider>
          <LightboxProvider>{element}</LightboxProvider>
        </PhotoDeleteProvider>
      </MemoryRouter>,
    ),
  )
  await idle()
}

const bigView = () => document.querySelector<HTMLElement>('[data-lightbox]')
const viewed = () => bigView()?.querySelector('img')?.getAttribute('src')

beforeEach(async () => {
  await changeLanguage('de', false)
  photoCount = 3
  serve()
})

afterEach(async () => {
  await act(async () => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

describe('the day read', () => {
  it('shows a photo of the day in the shape it has, as wide as the column, from the original', async () => {
    await show(
      <Routes>
        <Route path="/tag/:date" element={<EntryPage />} />
      </Routes>,
      '/tag/2026-10-04',
    )
    const figures = [...box.querySelectorAll<HTMLImageElement>('img[data-photo-figure]')]
    expect(figures.map((image) => image.getAttribute('src'))).toEqual([`/api/photos/${WIDE}`, `/api/photos/${TALL}`])
    expect(figures.map((image) => image.style.aspectRatio.replace(/\s/g, ''))).toEqual(['4000/1000', '1000/4000'])
    // Never cut: the whole picture inside the space, however tall; the width is the column's.
    for (const image of figures) {
      expect(image.className).toContain('object-contain')
      expect(image.className).toContain('w-full')
      expect(image.className).not.toContain('object-cover')
    }
  })

  it('opens the big view on a tap, on the photos of the day, the cover and the small tile of a note', async () => {
    await show(
      <Routes>
        <Route path="/tag/:date" element={<EntryPage />} />
      </Routes>,
      '/tag/2026-10-04',
    )
    await act(async () => box.querySelectorAll<HTMLElement>('button[aria-label="Foto"]')[1].click())
    await until(bigView, 'the big view')
    // The original, and the arrows run through all the photos of the day.
    expect(viewed()).toBe(`/api/photos/${TALL}`)
    expect(bigView()!.textContent).toContain('3 von 4')
    await act(async () => bigView()!.querySelector<HTMLElement>('[data-close]')!.click())
    await until(() => bigView() === null, 'the view closing')
    await act(async () => box.querySelector<HTMLElement>('[data-cover-open]')!.click())
    await until(bigView, 'the big view')
    expect(viewed()).toBe(`/api/photos/${COVER}`)
    expect(bigView()!.textContent).toContain('1 von 4')
  })
})

describe('a shared day', () => {
  it('shows the photos in their shape and opens the originals through the share', async () => {
    await show(
      <Routes>
        <Route path="/geteilt/:from/:date" element={<SharedEntryPage />} />
      </Routes>,
      '/geteilt/7/2026-10-04',
    )
    const figures = [...box.querySelectorAll<HTMLImageElement>('img[data-photo-figure]')]
    expect(figures.map((image) => image.getAttribute('src'))).toEqual([`/api/shared/7/2026-10-04/photos/${WIDE}`, `/api/shared/7/2026-10-04/photos/${TALL}`])
    await act(async () => box.querySelectorAll<HTMLElement>('button[aria-label="Foto"]')[0].click())
    await until(bigView, 'the big view')
    expect(viewed()).toBe(`/api/shared/7/2026-10-04/photos/${WIDE}`)
    // Who a day is shared with cannot delete the owner's photo.
    expect(bigView()!.querySelector('[aria-label="Foto löschen"]')).toBeNull()
  })
})

describe('the menu', () => {
  const entries = () => [...box.querySelectorAll('aside nav a')].map((link) => link.textContent?.trim())

  it('offers "Fotos" once there is a photo', async () => {
    await show(
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<p>Heute</p>} />
          <Route path="fotos" element={<p>Fotos hier</p>} />
        </Route>
      </Routes>,
      '/',
    )
    await until(() => entries().includes('Fotos'), 'the entry')
    expect(entries()).toEqual(['Heute', 'Tagebuch', 'Fotos', 'Statistik', 'Zeitkapseln', 'Geteilt'])
    // The bar of a phone holds five, as the mock: there "Fotos" is in the account menu of the header.
    expect([...box.querySelectorAll('main ~ nav a')].map((link) => link.getAttribute('href'))).toEqual(['/', '/tagebuch', '/statistik', '/zeitkapseln', '/geteilt'])
    // Five equal parts that may shrink, each word cut rather than pushing the bar wider than the phone.
    for (const link of box.querySelectorAll('main ~ nav a')) {
      expect(link.className).toMatch(/\bmin-w-0\b/)
      expect(link.className).toMatch(/\bflex-1\b/)
      expect(link.querySelector('span.truncate')).not.toBeNull()
    }
    await act(async () => box.querySelector<HTMLButtonElement>('main button[aria-haspopup]')!.click())
    expect(box.querySelector('main a[href="/fotos"]')?.textContent?.trim()).toBe('Fotos')
  })

  it('has no such entry without a photo', async () => {
    photoCount = 0
    await show(
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<p>Heute</p>} />
        </Route>
      </Routes>,
      '/',
    )
    await idle()
    expect(entries()).toEqual(['Heute', 'Tagebuch', 'Statistik', 'Zeitkapseln', 'Geteilt'])
    expect(box.querySelector('a[href="/fotos"]')).toBeNull()
    await act(async () => box.querySelector<HTMLButtonElement>('main button[aria-haspopup]')!.click())
    expect(box.querySelector('a[href="/fotos"]')).toBeNull()
  })
})
