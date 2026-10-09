/**
 * Time capsules as the mock shows them: both tabs with their counts, the sealed envelopes that say only who and when,
 * the one opened today with "Brief lesen", the own capsules with "Ändern", "Zurückziehen" and "versiegelt", and the
 * dialog with several people and the hint that follows the choice. The letter is written in the editor of the diary
 * (without a picture button) and read as a page, its photos as a gallery that opens the big view; many photos go up
 * one after the other. Hostile titles, names and letters stay text.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import type { CapsuleLists, CapsuleView } from '../api/client'
import { LightboxProvider } from '../components/Lightbox'
import '../i18n'
import { changeLanguage } from '../i18n'
import { idle, until } from '../test/wait'
import { CapsulesPage, daysBetween, uploadPause } from './CapsulesPage'

const me = { id: 1, name: 'jule', display_name: 'Jule', role: 'member', avatar: null, profile: { timezone: 'Europe/Berlin' } }
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))
const refresh = vi.fn()
vi.mock('../state/capsules', () => ({ useCapsules: () => ({ opened: 1, refresh }) }))

const HOSTILE = '<img src=x onerror="window.__xss=1">'
const TOM = { id: 2, name: 'tom', display_name: 'Tom', avatar: null }
const MIA = { id: 3, name: 'mia', display_name: 'Mia', avatar: null }
const ME_PERSON = { id: 1, name: 'jule', display_name: 'Jule', avatar: null }
const ID = (n: number) => String(n % 10).repeat(31) + String(Math.floor(n / 10))

const LISTS: CapsuleLists = {
  today: '2026-10-09',
  for_me: [
    { id: ID(1), from: ME_PERSON, self: true, title: 'An mich, in einem Jahr', opens_on: '2026-10-09', written_on: '2025-10-06', open: true, new: true, photos: 2, photo: ID(21) },
    { id: ID(2), from: TOM, self: false, title: `Für Heiligabend ${HOSTILE}`, opens_on: '2026-12-24', written_on: '2026-09-14', open: false, new: false },
    { id: ID(3), from: null, self: false, title: 'Von früher', opens_on: '2031-05-12', written_on: '2026-05-12', open: false, new: false },
  ],
  from_me: [
    { id: ID(4), title: 'Vorsätze', opens_on: '2027-01-01', written_on: '2026-10-01', to: [ME_PERSON, TOM], hidden: 0, sealed: false, opened: false, revision: 2 },
    { id: ID(5), title: 'Wo stehe ich in einem Jahr?', opens_on: '2027-10-06', written_on: '2026-10-06', to: [ME_PERSON], hidden: 0, sealed: true, opened: false, revision: 0 },
    { id: ID(1), title: 'An mich, in einem Jahr', opens_on: '2026-10-09', written_on: '2025-10-06', to: [ME_PERSON], hidden: 0, sealed: true, opened: true, revision: 0 },
    { id: ID(6), title: 'Für Ruth', opens_on: '2028-03-01', written_on: '2026-10-02', to: [], hidden: 1, sealed: false, opened: false, revision: 1 },
  ],
  new: 1,
}

const LETTER: CapsuleView = {
  id: ID(1), from: ME_PERSON, self: true, title: 'An mich, in einem Jahr', opens_on: '2026-10-09', written_on: '2025-10-06',
  sealed: true, for_me: true, open: true, text: `Heute war ein **langer** Tag.\n\nUnd ${HOSTILE} morgen?`,
  photos: [{ id: ID(21), width: 64, height: 48 }, { id: ID(22), width: 48, height: 64 }],
}
const OWN: CapsuleView = {
  id: ID(4), from: ME_PERSON, self: true, title: 'Vorsätze', opens_on: '2027-01-01', written_on: '2026-10-01', sealed: false,
  for_me: true, open: false, photos: [{ id: ID(23), width: 64, height: 48 }], text: '**Mehr** Sport.', to: [ME_PERSON, TOM], revision: 2, opened: false,
}

type Call = { method: string; url: string; body: unknown }
let calls: Call[] = []
let letter: CapsuleView = LETTER
/** Answers of the photo uploads still to come, in order; empty: each upload is kept under a new id. */
let uploads: (() => Response | Promise<Response>)[] = []
let uploaded = 0

function serve(): void {
  calls = []
  letter = LETTER
  uploads = []
  uploaded = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/capsules' && method === 'GET') return json(LISTS)
      if (url === '/api/capsules' && method === 'POST') {
        const body = JSON.parse(String(init?.body))
        return json({ ...OWN, id: ID(7), title: body.title, opens_on: body.opens_on, text: body.text, revision: 0 }, 201)
      }
      if (url === '/api/people') return json([TOM, MIA])
      if (url === `/api/capsules/${ID(1)}`) return json(letter)
      if (url === `/api/capsules/${ID(4)}` && method === 'GET') return json(OWN)
      if (url === `/api/capsules/${ID(4)}` && method === 'PUT') return json({ ...OWN, revision: 3 })
      if (url.startsWith('/api/capsules/photos?') && method === 'POST') {
        const next = uploads.shift()
        if (next) return next()
        uploaded += 1
        return json({ id: ID(30 + uploaded), width: 64, height: 48 }, 201)
      }
      if (url === `/api/capsules/${ID(6)}` && method === 'GET') return json({ ...OWN, id: ID(6), title: 'Für Ruth', to: [], hidden: 1, revision: 1 })
      if (url.endsWith('/read') || method === 'DELETE') return new Response(null, { status: 204 })
      return json({ detail: { code: 'not_found', message: 'Not found.' } }, 404)
    }),
  )
}

let root: Root
let box: HTMLDivElement

function Where() {
  const location = useLocation()
  return <output data-testid="where">{location.search}</output>
}

async function show(path = '/zeitkapseln'): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <LightboxProvider>
          <Where />
          <Routes>
            <Route path="/zeitkapseln" element={<CapsulesPage />} />
          </Routes>
        </LightboxProvider>
      </MemoryRouter>,
    )
  })
  await idle()
}

const tabs = () => [...box.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())
/** A button by its words; the initial of a picture without a photo in front of a name is not among them. */
const buttonNamed = (text: string, inside: ParentNode = box) =>
  [...inside.querySelectorAll('button')].find((button) => button.textContent?.trim() === text || button.querySelector('span.truncate')?.textContent === text || button.getAttribute('aria-label') === text) as HTMLButtonElement | undefined
const click = async (element: HTMLElement | null | undefined) => {
  expect(element).toBeTruthy()
  await act(async () => element!.click())
  await idle()
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]:not([data-lightbox])')
const hint = () => dialog()?.querySelector('[data-hint]')?.textContent?.trim()
const editor = () => until(() => dialog()?.querySelector<HTMLElement>('[contenteditable]'), 'the editor starting')

/** Text typed into the editor, the way the browser puts it into the page (ProseMirror reads it from there). */
async function typeInEditor(text: string, settle = true): Promise<void> {
  const paragraph = (await editor()).querySelector('p')!
  await act(async () => {
    if (paragraph.firstChild && paragraph.firstChild.nodeType === Node.TEXT_NODE) paragraph.firstChild.textContent = text
    else paragraph.replaceChildren(document.createTextNode(text))
    await Promise.resolve()
  })
  if (settle) await idle()
}

/** The title of the capsule, typed. */
async function typeTitle(text: string): Promise<void> {
  const field = dialog()!.querySelector('input:not([type])') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function choose(files: File[], camera = false): Promise<void> {
  const input = dialog()!.querySelector<HTMLInputElement>(camera ? 'input[type="file"][capture]' : 'input[type="file"][multiple]')!
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
  await idle()
}

const picture = (name: string) => new File([new Uint8Array([255, 216, 255])], name, { type: 'image/jpeg' })

beforeAll(async () => {
  await changeLanguage('de')
  // The editor is loaded lazily, as in the app; loaded once here, so that no test waits for its first load.
  await import('../editor/DiaryEditor')
})

beforeEach(() => {
  serve()
  refresh.mockClear()
  ;(window as { __xss?: number }).__xss = undefined
  // jsdom draws no pictures: stand-in addresses for the previews of chosen photos.
  let made = 0
  URL.createObjectURL = () => `blob:bild-${++made}`
  URL.revokeObjectURL = () => undefined
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
  uploadPause.ms = 15_000
})

describe('the time capsules page', () => {
  it('shows both tabs with their counts, and for me the envelopes that tell only who and when', async () => {
    await show()
    expect(box.querySelector('h1')?.textContent).toBe('Zeitkapseln')
    expect(tabs()).toEqual(['Für mich (3)', 'Von mir (4)'])
    const sealed = [...box.querySelectorAll('[data-sealed]')]
    expect(sealed.map((card) => card.getAttribute('data-sealed'))).toEqual([ID(2), ID(3)])
    const first = sealed[0].textContent ?? ''
    expect(first).toContain('Von Tom')
    expect(first).toContain(`Für Heiligabend ${HOSTILE}`)
    expect(first).toContain('Öffnet sich am Donnerstag, 24. Dezember 2026')
    expect(first).toContain('in 3 Monaten')
    expect(sealed[1].textContent).toContain('Von einem gelöschten Konto')
    expect(sealed[1].textContent).toContain('in 5 Jahren')
    expect(box.querySelectorAll('[data-sealed] .rounded-full.bg-accent svg').length).toBe(2)
    expect(box.querySelectorAll('[data-sealed] img').length).toBe(0)
    // The opened one is listed under "Geöffnet", new.
    const opened = [...box.querySelectorAll('section')].find((section) => section.querySelector('h2')?.textContent === 'Geöffnet')
    const row = opened?.querySelector('button')
    expect(row?.textContent).toContain('An mich, in einem Jahr')
    expect(row?.textContent).toContain('Von dir, geschrieben am Montag, 6. Oktober 2025')
    expect(row?.textContent).toContain('neu')
    expect((window as { __xss?: number }).__xss).toBeUndefined()
    expect(box.querySelector('img[src="x"]')).toBeNull()
  })

  it('shows what opened today, big, and "Brief lesen" opens the letter as a page and marks it read', async () => {
    await show()
    const today = box.querySelector('section[aria-label="Heute geöffnet"]') as HTMLElement
    expect(today.textContent).toContain('Heute geöffnet')
    expect(today.textContent).toContain('Du hast diesen Brief vor 1 Jahr geschrieben, am Montag, 6. Oktober 2025.')
    expect(today.querySelector('img')?.getAttribute('src')).toBe(`/api/capsules/${ID(1)}/photos/${ID(21)}`)
    await click(buttonNamed('Brief lesen', today))
    const read = await until(() => dialog()?.querySelector('[data-letter]'), 'the letter')
    expect([...read.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['Heute war ein langer Tag.', `Und ${HOSTILE} morgen?`])
    expect(read.querySelector('strong')?.textContent).toBe('langer')
    expect(read.querySelector('.prose-diary')).not.toBeNull()
    expect(dialog()?.textContent).toContain('Von dir, geschrieben am Montag, 6. Oktober 2025, geöffnet am Freitag, 9. Oktober 2026')
    expect(calls.some((call) => call.method === 'POST' && call.url === `/api/capsules/${ID(1)}/read`)).toBe(true)
    expect(refresh).toHaveBeenCalled()
    expect((window as { __xss?: number }).__xss).toBeUndefined()
    expect(document.querySelector('img[src="x"]')).toBeNull()
  })

  it('shows the photos as a gallery under the letter, a tap opens the big view, Escape closes only that', async () => {
    await show()
    await click(buttonNamed('Brief lesen', box.querySelector('section[aria-label="Heute geöffnet"]')!))
    const gallery = await until(() => dialog()?.querySelector<HTMLElement>('[data-gallery]'), 'the gallery')
    expect(gallery.getAttribute('aria-label')).toBe('2 Fotos')
    // Under the letter, not above it.
    const letterBox = dialog()!.querySelector('[data-letter]')!
    expect(letterBox.compareDocumentPosition(gallery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const thumbs = [...gallery.querySelectorAll('button')]
    expect(thumbs.map((button) => button.getAttribute('aria-label'))).toEqual(['Foto 1 von 2 groß ansehen', 'Foto 2 von 2 groß ansehen'])
    expect(thumbs.map((button) => button.querySelector('img')?.getAttribute('src'))).toEqual([`/api/capsules/${ID(1)}/photos/${ID(21)}/preview`, `/api/capsules/${ID(1)}/photos/${ID(22)}/preview`])
    expect(gallery.querySelector('img[loading]')).toBeNull()
    await click(thumbs[1])
    const view = await until(() => document.querySelector<HTMLElement>('[data-lightbox]'), 'the big view')
    expect(view.querySelector('img')?.getAttribute('src')).toBe(`/api/capsules/${ID(1)}/photos/${ID(22)}`)
    expect(view.textContent).toContain('2 von 2')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await idle()
    expect(document.querySelector('[data-lightbox]')).toBeNull()
    expect(dialog()).not.toBeNull()
    expect(dialog()!.querySelector('[data-letter]')).not.toBeNull()
  })

  it('reads a letter written before the editor as the words it was, line by line', async () => {
    // As the server gives out a letter of plain words: every punctuation character escaped, line ends kept.
    letter = { ...LETTER, photos: [], text: 'Lieber Tom\\,\\\n\\*das\\* ist kein Fett und \\# keine Überschrift\\.\\\n\\- kein Punkt\n\nBis bald \\\\o\\/' }
    await show()
    await click(buttonNamed('Brief lesen', box.querySelector('section[aria-label="Heute geöffnet"]')!))
    const read = await until(() => dialog()?.querySelector('[data-letter]'), 'the letter')
    const paragraphs = [...read.querySelectorAll('p')]
    expect(paragraphs.map((p) => p.textContent)).toEqual(['Lieber Tom,*das* ist kein Fett und # keine Überschrift.- kein Punkt', 'Bis bald \\o/'])
    expect(paragraphs[0].querySelectorAll('br').length).toBe(2)
    expect(read.querySelector('strong, em, h2, ul, blockquote')).toBeNull()
    expect(dialog()!.querySelector('[data-gallery]')).toBeNull()
  })

  it('lists my own with their people, "Ändern" and "Zurückziehen", "versiegelt" for a letter to myself', async () => {
    await show('/zeitkapseln?tab=von-mir')
    const row = (id: string) => box.querySelector(`[data-capsule="${id}"]`) as HTMLElement
    const toOthers = row(ID(4))
    expect(toOthers.textContent).toContain('An dich selbst und Tom · öffnet sich am Freitag, 1. Januar 2027, in 3 Monaten')
    expect(toOthers.querySelectorAll('.-space-x-2 > span').length).toBe(2)
    expect(buttonNamed('Ändern', toOthers)).toBeTruthy()
    expect(buttonNamed('Zurückziehen', toOthers)).toBeTruthy()
    const toMe = row(ID(5))
    expect(toMe.textContent).toContain('versiegelt')
    expect(buttonNamed('Ändern', toMe)).toBeUndefined()
    expect(buttonNamed('Zurückziehen', toMe)).toBeTruthy()
    const done = row(ID(1))
    expect(done.textContent).toContain('An dich selbst · geöffnet am Freitag, 9. Oktober 2026')
    expect(done.querySelectorAll('button').length).toBe(0)
    // Asked first, quietly; "Abbrechen" leaves it where it is.
    await click(buttonNamed('Zurückziehen', toMe))
    expect(dialog()?.getAttribute('aria-label')).toBe('Zeitkapsel zurückziehen?')
    expect(dialog()?.querySelector('[data-withdraw-text]')?.textContent?.trim()).toBe('Sie verschwindet bei allen Empfängern und lässt sich nicht wiederherstellen.')
    await click(buttonNamed('Abbrechen', dialog()!))
    expect(dialog()).toBeNull()
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    await click(buttonNamed('Zurückziehen', toMe))
    await click(buttonNamed('Zurückziehen', dialog()!))
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.url)).toEqual([`/api/capsules/${ID(5)}`])
    expect(row(ID(5))).toBeNull()
  })

  it('writes a new capsule in the editor for several people, the hint following the choice', async () => {
    await show()
    await click(buttonNamed('Neue Zeitkapsel'))
    await until(() => buttonNamed('Tom', dialog()!), 'the people')
    const chip = (name: string) => buttonNamed(name, dialog()!)!
    expect(chip('Mich selbst').getAttribute('aria-pressed')).toBe('true')
    expect(hint()).toBe('Ein Brief an dich selbst wird versiegelt: Bis zum Tag kannst du ihn weder lesen noch ändern, nur zurückziehen. Am Tag selbst kommt eine Nachricht aufs Handy.')
    await editor()
    expect(dialog()!.textContent).toContain('Was beschäftigt dich gerade? Was hoffst du, wenn du das liest?')
    await click(chip('Tom'))
    expect(hint()).toBe('Tom sieht bis dahin nur, dass ein Brief von dir wartet, nicht was drinsteht. Du kannst ihn bis zum Tag ändern oder zurückziehen. Am Tag selbst kommt eine Nachricht aufs Handy.')
    await click(chip('Mia'))
    expect(hint()).toContain('Tom und Mia sehen bis dahin nur, dass ein Brief von dir wartet')
    await click(chip('Mich selbst'))
    expect(chip('Mich selbst').getAttribute('aria-pressed')).toBe('false')
    expect(hint()).toContain('Tom und Mia sehen')
    // The placeholder of the letter follows the choice too.
    expect(dialog()!.textContent).toContain('Was möchtest du Tom und Mia sagen, wenn der Tag gekommen ist?')
    expect(dialog()!.querySelector('textarea')).toBeNull()
    // The quick choices of the day, and the date it shows.
    expect(dialog()!.textContent).toContain('Samstag, 9. Oktober 2027, in 12 Monaten.')
    await click(chip('In fünf Jahren'))
    expect(dialog()!.textContent).toContain('in 5 Jahren.')
    await click(chip('Silvester'))
    expect(chip('Silvester').getAttribute('aria-pressed')).toBe('true')
    const seal = buttonNamed('Verschließen', dialog()!)!
    expect(seal.disabled).toBe(true)
    await typeTitle('Für euch beide')
    expect(seal.disabled).toBe(true)
    await typeInEditor('Liebe Grüße')
    expect(seal.disabled).toBe(false)
    await click(seal)
    const sent = calls.find((call) => call.method === 'POST' && call.url === '/api/capsules')!
    expect(sent.body).toMatchObject({ to: [2, 3], opens_on: '2026-12-31', title: 'Für euch beide', text: 'Liebe Grüße', photos: [] })
    expect(String((sent.body as { id: string }).id)).toMatch(/^[0-9a-f-]{36}$/)
    expect(dialog()).toBeNull()
    expect(box.querySelector('[data-testid="where"]')?.textContent).toBe('?tab=von-mir')
  })

  it('gives the letter the bar of the writing page, without a picture button, in a dialog that fills a phone', async () => {
    await show()
    await click(buttonNamed('Neue Zeitkapsel'))
    await editor()
    const bar = await until(() => dialog()!.querySelector<HTMLElement>('[data-letter-editor] [role="toolbar"]'), 'the bar')
    expect([...bar.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))).toEqual(['Fett', 'Kursiv', 'Zwischenüberschrift', 'Zitat', 'Liste', 'Rückgängig'])
    expect(dialog()!.querySelector('[aria-label="Bild einfügen"]')).toBeNull()
    // The bar stands in its own sticky holder above the text, so that it stays in view while the letter scrolls.
    expect(bar.parentElement?.className).toContain('sticky')
    expect(dialog()!.className).toContain('h-[100dvh]')
    expect(dialog()!.className).toContain('sm:h-auto')
  })

  it('names recipients blocked since by their number, and never calls their letter sealed', async () => {
    await show('/zeitkapseln?tab=von-mir')
    const row = box.querySelector(`[data-capsule="${ID(6)}"]`) as HTMLElement
    expect(row.textContent).toContain('An 1 weitere Person · öffnet sich am Mittwoch, 1. März 2028')
    expect(row.textContent).not.toContain('versiegelt')
    await click(buttonNamed('Ändern', row))
    await until(() => buttonNamed('Tom', dialog()!), 'the people')
    expect(hint()).toContain('1 weitere Person sieht bis dahin nur, dass ein Brief von dir wartet')
    await click(buttonNamed('Mich selbst', dialog()!))
    expect(hint()).toContain('1 weitere Person sieht bis dahin nur')
    expect(hint()).not.toContain('versiegelt')
  })

  it('takes many photos at once, sends them up one after the other, and seals them in their order', async () => {
    await show()
    await click(buttonNamed('Neue Zeitkapsel'))
    await editor()
    expect(buttonNamed('Fotos dazulegen', dialog()!)).toBeTruthy()
    expect(dialog()!.querySelector('input[type="file"][multiple]')?.getAttribute('accept')).toBe('image/*')
    // The camera of a phone, beside the choice of files; hidden from the size of a tablet on.
    expect(buttonNamed('Foto aufnehmen', dialog()!)?.className).toContain('sm:hidden')
    expect(dialog()!.querySelector('input[type="file"][capture="environment"]')).not.toBeNull()
    await choose([picture('a.jpg'), picture('b.jpg'), picture('c.jpg')])
    await choose([picture('d.jpg')], true)
    const posts = calls.filter((call) => call.method === 'POST' && call.url.startsWith('/api/capsules/photos?'))
    expect(posts.length).toBe(4)
    expect(new Set(posts.map((call) => call.url)).size).toBe(4)
    const tiles = [...dialog()!.querySelectorAll('[data-tile]')]
    expect(tiles.map((tile) => tile.getAttribute('data-tile'))).toEqual(['new', 'new', 'new', 'new'])
    expect(tiles.map((tile) => tile.querySelector('img')?.getAttribute('src'))).toEqual(['blob:bild-1', 'blob:bild-2', 'blob:bild-3', 'blob:bild-4'])
    expect(dialog()!.querySelector('[data-tiles]')?.getAttribute('aria-label')).toBe('4 Fotos')
    // The second taken out again: the server lets go of it at once.
    await click(buttonNamed('Foto entfernen', tiles[1] as HTMLElement))
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.url)).toEqual([`/api/capsules/photos/${ID(32)}`])
    await typeTitle('Mit Fotos')
    await typeInEditor('Schau mal')
    await click(buttonNamed('Verschließen', dialog()!))
    const sent = calls.find((call) => call.method === 'POST' && call.url === '/api/capsules')!
    expect((sent.body as { photos: string[] }).photos).toEqual([ID(31), ID(33), ID(34)])
    // Sealed with the capsule: nothing let go of when the dialog went.
    expect(calls.filter((call) => call.method === 'DELETE').length).toBe(1)
  })

  it('waits by itself when the server says too many photos came at once, then goes on', async () => {
    uploadPause.ms = 1
    await show()
    await click(buttonNamed('Neue Zeitkapsel'))
    await editor()
    uploads = [() => new Response(JSON.stringify({ detail: { code: 'too_many_uploads', message: 'Too many photos at once. Wait a minute.' } }), { status: 429, headers: { 'Content-Type': 'application/json' } })]
    await choose([picture('a.jpg'), picture('b.jpg')])
    await until(() => [...dialog()!.querySelectorAll('[data-tile]')].every((tile) => tile.getAttribute('data-tile') === 'new') && dialog()!.querySelectorAll('[data-tile]').length === 2, 'both photos up')
    const posts = calls.filter((call) => call.method === 'POST' && call.url.startsWith('/api/capsules/photos?'))
    expect(posts.length).toBe(3)
    expect(posts[0].url).toBe(posts[1].url)
    expect(dialog()!.textContent).not.toContain('Zu viele Fotos')
  })

  it('cannot seal while a photo is still on its way, and lets go of every chosen photo when the dialog is left', async () => {
    await show()
    await click(buttonNamed('Neue Zeitkapsel'))
    await editor()
    let release: () => void = () => undefined
    uploads = [() => new Promise<Response>((done) => (release = () => done(new Response(JSON.stringify({ id: ID(41), width: 64, height: 48 }), { status: 201, headers: { 'Content-Type': 'application/json' } }))))]
    await act(async () => {
      const input = dialog()!.querySelector<HTMLInputElement>('input[type="file"][multiple]')!
      Object.defineProperty(input, 'files', { value: [picture('a.jpg'), picture('b.jpg')], configurable: true })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await until(() => dialog()!.querySelector('[data-tile="uploading"] [role="status"]'), 'the photo going up')
    await typeTitle('Titel')
    await typeInEditor('Text', false)
    expect(dialog()!.querySelectorAll('[data-tile="uploading"]').length).toBe(2)
    expect(buttonNamed('Verschließen', dialog()!)!.disabled).toBe(true)
    await act(async () => release())
    await until(() => [...dialog()!.querySelectorAll('[data-tile]')].every((tile) => tile.getAttribute('data-tile') === 'new'), 'both photos up')
    expect(buttonNamed('Verschließen', dialog()!)!.disabled).toBe(false)
    await click(buttonNamed('Abbrechen', dialog()!))
    await idle()
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.url).sort()).toEqual([`/api/capsules/photos/${ID(31)}`, `/api/capsules/photos/${ID(41)}`])
  })

  it('changes a capsule to others with its revision: the letter in the editor, the photos kept, one added', async () => {
    await show('/zeitkapseln?tab=von-mir')
    await click(buttonNamed('Ändern', box.querySelector(`[data-capsule="${ID(4)}"]`)!))
    await until(() => buttonNamed('Tom', dialog()!), 'the people')
    expect(dialog()!.getAttribute('aria-label')).toBe('Zeitkapsel ändern')
    const text = await editor()
    expect(text.textContent).toBe('Mehr Sport.')
    expect(text.querySelector('strong')?.textContent).toBe('Mehr')
    expect(buttonNamed('Tom', dialog()!)!.getAttribute('aria-pressed')).toBe('true')
    const kept = dialog()!.querySelector('[data-tile="kept"] img')
    expect(kept?.getAttribute('src')).toBe(`/api/capsules/${ID(4)}/photos/${ID(23)}/preview`)
    await choose([picture('neu.jpg')])
    await click(buttonNamed('Verschließen', dialog()!))
    const put = calls.find((call) => call.method === 'PUT')!
    expect(put.url).toBe(`/api/capsules/${ID(4)}`)
    expect(put.body).toEqual({ revision: 2, to: [1, 2], opens_on: '2027-01-01', title: 'Vorsätze', text: '**Mehr** Sport.', photos: [ID(23), ID(31)] })
  })
})

describe('days between', () => {
  it('counts calendar days across a change of summer time', () => {
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
    expect(daysBetween('2026-10-09', '2027-10-09')).toBe(365)
  })
})
