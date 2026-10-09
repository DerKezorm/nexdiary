/**
 * Time capsules as the mock shows them: both tabs with their counts, the sealed envelopes that say only who and when,
 * the one opened today with "Brief lesen", the own capsules with "Ändern", "Zurückziehen" and "versiegelt", and the
 * dialog with several people and the hint that follows the choice. Hostile titles, names and letters stay text.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import type { CapsuleLists, CapsuleView } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { idle, until } from '../test/wait'
import { CapsulesPage, daysBetween } from './CapsulesPage'

const me = { id: 1, name: 'jule', display_name: 'Jule', role: 'member', avatar: null, profile: { timezone: 'Europe/Berlin' } }
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))
const refresh = vi.fn()
vi.mock('../state/capsules', () => ({ useCapsules: () => ({ opened: 1, refresh }) }))

const HOSTILE = '<img src=x onerror="window.__xss=1">'
const TOM = { id: 2, name: 'tom', display_name: 'Tom', avatar: null }
const MIA = { id: 3, name: 'mia', display_name: 'Mia', avatar: null }
const ME_PERSON = { id: 1, name: 'jule', display_name: 'Jule', avatar: null }
const ID = (n: number) => String(n).repeat(32)

const LISTS: CapsuleLists = {
  today: '2026-10-09',
  for_me: [
    { id: ID(1), from: ME_PERSON, self: true, title: 'An mich, in einem Jahr', opens_on: '2026-10-09', written_on: '2025-10-06', open: true, new: true, photo: true },
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
  sealed: true, for_me: true, open: true, photo: true, text: `Heute war ein langer Tag.\n\nUnd ${HOSTILE} morgen?`,
}
const OWN: CapsuleView = {
  id: ID(4), from: ME_PERSON, self: true, title: 'Vorsätze', opens_on: '2027-01-01', written_on: '2026-10-01', sealed: false,
  for_me: true, open: false, photo: false, text: 'Mehr Sport.', to: [ME_PERSON, TOM], revision: 2, opened: false,
}

type Call = { method: string; url: string; body: unknown }
let calls: Call[] = []

function serve(): void {
  calls = []
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
      if (url === `/api/capsules/${ID(1)}`) return json(LETTER)
      if (url === `/api/capsules/${ID(4)}` && method === 'GET') return json(OWN)
      if (url === `/api/capsules/${ID(4)}` && method === 'PUT') return json({ ...OWN, revision: 3 })
      if (url.startsWith('/api/capsules/photos?') && method === 'POST') return json({ id: ID(8), width: 64, height: 48 }, 201)
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
        <Where />
        <Routes>
          <Route path="/zeitkapseln" element={<CapsulesPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await idle()
}

const tabs = () => [...box.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())
/** A button by its words; the initial of a picture without a photo in front of a name is not among them. */
const buttonNamed = (text: string, inside: ParentNode = box) =>
  [...inside.querySelectorAll('button')].find((button) => button.textContent?.trim() === text || button.querySelector('span.truncate')?.textContent === text) as HTMLButtonElement | undefined
const click = async (element: HTMLElement | null | undefined) => {
  expect(element).toBeTruthy()
  await act(async () => element!.click())
  await idle()
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const hint = () => dialog()?.querySelector('[data-hint]')?.textContent?.trim()

beforeAll(async () => {
  await changeLanguage('de')
})

beforeEach(() => {
  serve()
  refresh.mockClear()
  ;(window as { __xss?: number }).__xss = undefined
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
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
    // The opened one is listed under "Geöffnet", new.
    const opened = [...box.querySelectorAll('section')].find((section) => section.querySelector('h2')?.textContent === 'Geöffnet')
    const row = opened?.querySelector('button')
    expect(row?.textContent).toContain('An mich, in einem Jahr')
    expect(row?.textContent).toContain('Von dir, geschrieben am Montag, 6. Oktober 2025')
    expect(row?.textContent).toContain('neu')
    expect((window as { __xss?: number }).__xss).toBeUndefined()
    expect(box.querySelector('img[src="x"]')).toBeNull()
  })

  it('shows what opened today, big, and "Brief lesen" opens the letter and marks it read', async () => {
    await show()
    const today = box.querySelector('section[aria-label="Heute geöffnet"]') as HTMLElement
    expect(today.textContent).toContain('Heute geöffnet')
    expect(today.textContent).toContain('Du hast diesen Brief vor 1 Jahr geschrieben, am Montag, 6. Oktober 2025.')
    expect(today.querySelector('img')?.getAttribute('src')).toBe(`/api/capsules/${ID(1)}/photo`)
    await click(buttonNamed('Brief lesen', today))
    const letter = await until(() => dialog()?.querySelector('[data-letter]'), 'the letter')
    expect([...letter.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['Heute war ein langer Tag.', `Und ${HOSTILE} morgen?`])
    expect(dialog()?.textContent).toContain('Von dir, geschrieben am Montag, 6. Oktober 2025, geöffnet am Freitag, 9. Oktober 2026')
    expect(calls.some((call) => call.method === 'POST' && call.url === `/api/capsules/${ID(1)}/read`)).toBe(true)
    expect(refresh).toHaveBeenCalled()
    expect((window as { __xss?: number }).__xss).toBeUndefined()
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

  it('writes a new capsule for several people, the hint following the choice', async () => {
    await show()
    await click(buttonNamed('Neue Zeitkapsel'))
    await until(() => buttonNamed('Tom', dialog()!), 'the people')
    const chip = (name: string) => buttonNamed(name, dialog()!)!
    expect(chip('Mich selbst').getAttribute('aria-pressed')).toBe('true')
    expect(hint()).toBe('Ein Brief an dich selbst wird versiegelt: Bis zum Tag kannst du ihn weder lesen noch ändern, nur zurückziehen. Am Tag selbst kommt eine Nachricht aufs Handy.')
    await click(chip('Tom'))
    expect(hint()).toBe('Tom sieht bis dahin nur, dass ein Brief von dir wartet, nicht was drinsteht. Du kannst ihn bis zum Tag ändern oder zurückziehen. Am Tag selbst kommt eine Nachricht aufs Handy.')
    await click(chip('Mia'))
    expect(hint()).toContain('Tom und Mia sehen bis dahin nur, dass ein Brief von dir wartet')
    await click(chip('Mich selbst'))
    expect(chip('Mich selbst').getAttribute('aria-pressed')).toBe('false')
    expect(hint()).toContain('Tom und Mia sehen')
    expect(dialog()!.querySelector('textarea')!.getAttribute('placeholder')).toBe('Was möchtest du Tom und Mia sagen, wenn der Tag gekommen ist?')
    // The quick choices of the day, and the date it shows.
    expect(dialog()!.textContent).toContain('Samstag, 9. Oktober 2027, in 12 Monaten.')
    await click(chip('In fünf Jahren'))
    expect(dialog()!.textContent).toContain('in 5 Jahren.')
    await click(chip('Silvester'))
    expect(chip('Silvester').getAttribute('aria-pressed')).toBe('true')
    const seal = buttonNamed('Verschließen', dialog()!)!
    expect(seal.disabled).toBe(true)
    const type = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!
      await act(async () => {
        setter.call(field, value)
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await type(dialog()!.querySelector('input:not([type])') as HTMLInputElement, 'Für euch beide')
    await type(dialog()!.querySelector('textarea')!, 'Liebe Grüße')
    expect(seal.disabled).toBe(false)
    await click(seal)
    const sent = calls.find((call) => call.method === 'POST' && call.url === '/api/capsules')!
    expect(sent.body).toMatchObject({ to: [2, 3], opens_on: '2026-12-31', title: 'Für euch beide', text: 'Liebe Grüße', photo: null })
    expect(String((sent.body as { id: string }).id)).toMatch(/^[0-9a-f-]{36}$/)
    expect(dialog()).toBeNull()
    expect(box.querySelector('[data-testid="where"]')?.textContent).toBe('?tab=von-mir')
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

  it('lets go of a chosen photo at once when the dialog is left without sealing', async () => {
    await show()
    await click(buttonNamed('Neue Zeitkapsel'))
    await until(() => buttonNamed('Tom', dialog()!), 'the people')
    const file = new File([new Uint8Array([255, 216, 255])], 'bild.jpg', { type: 'image/jpeg' })
    const input = dialog()!.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    // jsdom draws no pictures: a stand-in address for the preview.
    URL.createObjectURL = () => 'blob:bild'
    URL.revokeObjectURL = () => undefined
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await idle()
    expect(calls.some((call) => call.method === 'POST' && call.url.startsWith('/api/capsules/photos?'))).toBe(true)
    await click(buttonNamed('Abbrechen', dialog()!))
    await idle()
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.url)).toEqual([`/api/capsules/photos/${ID(8)}`])
  })

  it('changes a capsule to others with its revision, the photo left as it is', async () => {
    await show('/zeitkapseln?tab=von-mir')
    await click(buttonNamed('Ändern', box.querySelector(`[data-capsule="${ID(4)}"]`)!))
    await until(() => buttonNamed('Tom', dialog()!), 'the people')
    expect(dialog()!.getAttribute('aria-label')).toBe('Zeitkapsel ändern')
    expect((dialog()!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Mehr Sport.')
    expect(buttonNamed('Tom', dialog()!)!.getAttribute('aria-pressed')).toBe('true')
    await click(buttonNamed('Verschließen', dialog()!))
    const put = calls.find((call) => call.method === 'PUT')!
    expect(put.url).toBe(`/api/capsules/${ID(4)}`)
    expect(put.body).toEqual({ revision: 2, to: [1, 2], opens_on: '2027-01-01', title: 'Vorsätze', text: 'Mehr Sport.' })
  })
})

describe('days between', () => {
  it('counts calendar days across a change of summer time', () => {
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2)
    expect(daysBetween('2026-10-09', '2027-10-09')).toBe(365)
  })
})
