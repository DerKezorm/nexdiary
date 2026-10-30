/**
 * "Meine Fotos" with its second tab: the storage split by kind, the tabs "Fotos · n" and "Anhänge · n" (the tab in the
 * address), the chips of the kinds, newest or largest first, the short date linked to the day, the next page, and
 * deleting (asked first, the storage line follows).
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'

import type { Attachment } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { LightboxProvider } from '../components/Lightbox'
import { PhotoDeleteProvider } from '../components/PhotoDelete'
import { eventually, idle } from '../test/wait'
import { LibraryPage } from './LibraryPage'

vi.mock('../state/auth', () => ({ useAuth: () => ({ me: { profile: { timezone: 'Europe/Berlin' } } }) }))

const hex = (n: number) => String(n).repeat(32).slice(0, 32)
function item(n: number, kind: Attachment['kind'], date: string, over: Partial<Attachment> = {}): Attachment {
  return { id: hex(n), date, kind, name: `Anhang ${n}`, size: n * 1024 * 1024, seconds: null, width: null, height: null, codec: null, status: 'ready', progress: null, playable: true, can_convert: false, has_preview: false, created_at: '', ...over }
}

const MB = 1024 * 1024
let storage: Record<string, unknown> = {}
let calls: { method: string; url: string }[] = []

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
      const address = new URL(url, 'http://x')
      if (address.pathname === '/api/photos/storage') return json(storage)
      if (address.pathname === '/api/photos/library') return json({ photos: [], next: null })
      if (address.pathname === '/api/attachments/library') {
        const kind = address.searchParams.get('kind')
        const before = address.searchParams.get('before')
        const all = [
          item(1, 'video', '2026-10-04', { name: 'Mia am Steg', seconds: 48, codec: 'hevc' }),
          item(2, 'audio', '2026-10-03', { name: 'Lied im Auto', seconds: 72 }),
          item(3, 'link', '2026-10-02', { name: 'Wochenmarkt', url: 'https://markt.example.com', size: 0 }),
        ].filter((entry) => !kind || entry.kind === kind)
        if (before) return json({ attachments: [item(4, 'pdf', '2026-09-12', { name: 'Elternbrief.pdf' })], next: null })
        return json({ attachments: all, next: kind ? null : 'cursor-1' })
      }
      if (address.pathname.startsWith('/api/attachments/') && method === 'DELETE') return new Response(null, { status: 204 })
      return json({})
    }),
  )
}

let root: Root
let box: HTMLDivElement
let where = ''

function Where() {
  const location = useLocation()
  useEffect(() => {
    where = location.search
  }, [location.search])
  return null
}

async function show(path: string): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  box.id = 'root'
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <PhotoDeleteProvider>
          <LightboxProvider>
            <LibraryPage />
            <Where />
          </LightboxProvider>
        </PhotoDeleteProvider>
      </MemoryRouter>,
    ),
  )
  await idle()
}

const tabs = () => [...box.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)
const rows = () => [...box.querySelectorAll('[data-attachment-library] li[data-attachment]')].map((row) => row.querySelector('.font-semibold')!.textContent)
const button = (label: string) => [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === label || element.getAttribute('aria-label') === label)
const library = () => calls.filter((call) => call.url.startsWith('/api/attachments/library')).map((call) => new URL(call.url, 'http://x').searchParams)

beforeEach(async () => {
  await changeLanguage('de', false)
  storage = { used: 1288 * MB, limit: 5 * 1024 * MB, count: 12, attachments: 4, by_kind: { photos: 700 * MB, video: 500 * MB, audio: 50 * MB, pdf: 38 * MB } }
  serve()
})

afterEach(async () => {
  await act(async () => root.unmount())
  box.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('the storage', () => {
  it('splits the space into photos, videos, and recordings with PDFs', async () => {
    await show('/fotos')
    const card = box.querySelector('[data-testid="storage"]')!
    expect(card.textContent).toContain('Speicher')
    expect(card.textContent).toContain('1,3 GB von 5 GB')
    expect(card.querySelector('[data-storage-parts]')!.textContent).toBe(' Fotos 700 MB Videos 500 MB Aufnahmen und PDFs 88 MB')
    const bar = card.querySelector('[role="img"]')!
    expect(bar.getAttribute('aria-label')).toBe('25 Prozent deines Platzes belegt')
    expect([...bar.children].map((part) => (part as HTMLElement).style.width)).toEqual([`${(700 / 5120) * 100}%`, `${(500 / 5120) * 100}%`, `${(88 / 5120) * 100}%`])
  })
})

describe('the tabs', () => {
  it('count the photos and the attachments, start on the photos and keep the tab in the address', async () => {
    await show('/fotos')
    expect(tabs()).toEqual(['Fotos · 12', 'Anhänge · 4'])
    expect(box.querySelector('[data-attachment-library]')).toBeNull()
    expect(library()).toHaveLength(0)
    await act(async () => (box.querySelectorAll('[role="tab"]')[1] as HTMLElement).click())
    await idle()
    expect(where).toBe('?tab=anhaenge')
    expect(box.querySelector('[data-attachment-library]')).not.toBeNull()
    expect(box.querySelector('li[data-photo]')).toBeNull()
    await act(async () => (box.querySelectorAll('[role="tab"]')[0] as HTMLElement).click())
    expect(where).toBe('')
  })

  it('opens on the attachments from the address', async () => {
    await show('/fotos?tab=anhaenge')
    expect(box.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe('Anhänge · 4')
    expect(rows()).toEqual(['Mia am Steg', 'Lied im Auto', 'Wochenmarkt'])
  })
})

describe('the list of attachments', () => {
  it('says kind, length, HEVC and the short date linked to the day, and the size but not for a link', async () => {
    await show('/fotos?tab=anhaenge')
    const video = box.querySelector(`li[data-attachment="${hex(1)}"]`)!
    expect(video.textContent).toContain('Video · 0:48 · HEVC · 4. Okt. 2026')
    expect(video.querySelector('a')!.getAttribute('href')).toBe('/tag/2026-10-04')
    expect(video.textContent).toContain('1 MB')
    const link = box.querySelector(`li[data-attachment="${hex(3)}"]`)!
    expect(link.textContent).not.toContain(' MB')
  })

  it('filters by kind with the chips, sorts by size, and loads the next page', async () => {
    await show('/fotos?tab=anhaenge')
    const chips = [...box.querySelectorAll('[data-kind-filter] button')]
    expect(chips.map((chip) => chip.textContent)).toEqual(['Alle', 'Videos', 'Aufnahmen', 'PDFs', 'Links'])
    expect(box.querySelector('[data-kind-filter]')!.className).toContain('overflow-x-auto')
    expect(library()[0].get('order')).toBe('new')
    expect(library()[0].get('kind')).toBeNull()
    await act(async () => (chips[2] as HTMLElement).click())
    await idle()
    expect(library().at(-1)!.get('kind')).toBe('audio')
    expect(chips[2].getAttribute('aria-pressed')).toBe('true')
    expect(rows()).toEqual(['Lied im Auto'])
    await act(async () => (chips[0] as HTMLElement).click())
    await idle()
    await act(async () => button('Größte')!.click())
    await idle()
    expect(library().at(-1)!.get('order')).toBe('size')
    await act(async () => button('Mehr laden')!.click())
    await idle()
    expect(library().at(-1)!.get('before')).toBe('cursor-1')
    expect(rows()).toEqual(['Mia am Steg', 'Lied im Auto', 'Wochenmarkt', 'Elternbrief.pdf'])
    expect(button('Mehr laden')).toBeUndefined()
  })

  it('deletes after asking, and the storage line follows', async () => {
    await show('/fotos?tab=anhaenge')
    await act(async () => button('Anhang löschen: Lied im Auto')!.click())
    expect(document.body.textContent).toContain('„Lied im Auto“ verschwindet von diesem Tag und aus deinem Speicher.')
    storage = { ...storage, attachments: 3 }
    await act(async () => (document.querySelector('[data-remove-confirm]') as HTMLElement).click())
    await idle()
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.url)).toEqual([`/api/attachments/${hex(2)}`])
    expect(rows()).toEqual(['Mia am Steg', 'Wochenmarkt'])
    await eventually(() => expect(tabs()).toEqual(['Fotos · 12', 'Anhänge · 3']))
  })

  it('says so when there is nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
        if (url.startsWith('/api/attachments/library')) return json({ attachments: [], next: null })
        if (url.startsWith('/api/photos/storage')) return json(storage)
        return json({ photos: [], next: null })
      }),
    )
    await show('/fotos?tab=anhaenge')
    expect(box.querySelector('[data-library-empty]')!.textContent).toBe('Hier ist noch nichts. Anhänge legst du an einem Tag dazu.')
  })
})
