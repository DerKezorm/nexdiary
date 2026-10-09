/**
 * Writing a day up against a server stand-in: the page loads with its revision, a double click saves once, only what
 * was changed here is sent, the draft goes out while typing, when the page is left and when it is hidden, a field
 * changed meanwhile elsewhere is never overwritten unseen (the other version stands there to copy from), and a photo
 * can be deleted from the cover picker. The AI writes only on the press of the button that led here, once; its
 * suggestion becomes the writing, "Länger"/"Kürzer" ask anew, and the questions to insert become subheadings.
 */
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'

import '../i18n'
import { changeLanguage } from '../i18n'
import WritePage from './WritePage'
import { eventually, idle, until } from '../test/wait'

vi.mock('../state/auth', () => ({
  useAuth: () => ({ me: { name: 'jule', display_name: 'Jule', profile: { mode: 'light', layout: 'page', quick_start: false, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'manual' } } }),
}))

const DATE = '2026-10-06'
const PHOTO = 'c'.repeat(32)
type Day = Record<string, unknown> & { revision: number; title: string; text: string; tags: string[] }
type Call = { method: string; url: string; body: Record<string, unknown> | undefined; keepalive: boolean }

let calls: Call[] = []
let day: Day | null = null
let draft: Record<string, unknown> | null = null
let photos: Record<string, unknown>[] = []
/** What the next save meets: another device's page that came in between. */
let meanwhile: Day | null = null
let aiState: Record<string, unknown> = { provider: 'local', to: '', model: 'llama3.1:8b', mine: true, available: true }
let pool: { id: string; text: string; answered: boolean }[] = []
let dayNotes: Record<string, unknown>[] = []
/** Who the day is shared with. */
let sharedWith: Record<string, unknown>[] = []
/** Holds a draft on its way until the test lets it through. */
let draftGate: Promise<void> | null = null
/** What the router holds as the history state, seen from outside the page. */
let seenState: unknown = 'unset'
/** What the AI answers next: a suggestion, or an error code. */
let suggestion: { title: string; text: string } | string = { title: 'Kastanien', text: 'Am Abend habe ich mit Mia Kastanien gesammelt.' }

function page(fields: Partial<Day>): Day {
  return { date: DATE, title: '', text: '', tags: [], values: {}, cover: 'illu:baum.abend.herbst', cover_chosen: false, written_by: 'self', words: 0, revision: 0, created_at: '', updated_at: '2026-10-06T17:00:00+00:00', ...fields }
}

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body, keepalive: Boolean(init?.keepalive) })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === `/api/days/${DATE}/draft`) {
        if (method === 'PUT' && draftGate) await draftGate
        if (method === 'PUT') {
          draft = { ...body, updated_at: '2026-10-06T17:30:00+00:00' }
          return json(draft)
        }
        if (method === 'DELETE') {
          draft = null
          return new Response(null, { status: 204 })
        }
        return json(draft)
      }
      if (url === `/api/days/${DATE}/shares`) return json({ date: DATE, people: sharedWith, with_values: false, with_notes: false })
      if (url === `/api/days/${DATE}` && method === 'DELETE') {
        day = null
        draft = null
        return new Response(null, { status: 204 })
      }
      if (url === `/api/days/${DATE}/lock` && method === 'POST') {
        day = { ...day!, locked: true, locked_at: '2026-10-07T10:00:00+00:00' }
        return json(day)
      }
      if (url === `/api/days/${DATE}`) {
        if (method === 'PUT') {
          await new Promise((resolve) => setTimeout(resolve, 20))
          if (meanwhile) {
            day = meanwhile
            meanwhile = null
          }
          const standing = day ? day.revision : -1
          if (body!.base_revision !== standing) return json({ detail: { code: 'day_changed', message: 'x', revision: standing } }, 409)
          const { base_revision: _base, ...fields } = body!
          day = page({ ...(day ?? {}), ...fields, revision: standing + 1, cover_chosen: 'cover' in fields || Boolean(day?.cover_chosen) })
          draft = null
          return json(day)
        }
        return day ? json(day) : json({ detail: { code: 'not_found', message: 'x' } }, 404)
      }
      if (url.startsWith('/api/photos/') && method === 'DELETE') {
        photos = photos.filter((photo) => !url.endsWith(String(photo.id)))
        return new Response(null, { status: 204 })
      }
      if (url === '/api/ai/formulate') {
        await new Promise((resolve) => setTimeout(resolve, 20))
        if (typeof suggestion === 'string') return json({ detail: { code: suggestion, message: 'x' } }, 502)
        return json({ ...suggestion, length: body!.length })
      }
      if (url === '/api/ai') return json(aiState)
      if (url.startsWith('/api/prompts/pool')) return json({ questions: pool })
      if (url.startsWith('/api/notes')) return json(dayNotes)
      if (url.startsWith('/api/photos')) return json(photos)
      if (url.startsWith('/api/today')) return json({ date: DATE, notes: [], day, values: [], streak: 5, photos: [] })
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement
const away = { leave: () => undefined as void }


/** Leaves the writing page within the app, as a link or the back button would. */
function Away() {
  const navigate = useNavigate()
  const state = useLocation().state
  useEffect(() => {
    seenState = state
    away.leave = () => void navigate('/woanders')
  })
  return null
}

async function show(state: unknown = null, ready: () => unknown = () => box.querySelector('[contenteditable]') || box.textContent?.includes('verschlossen')): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[{ pathname: `/tag/${DATE}/schreiben`, state }]}>
        <Away />
        <Routes>
          <Route path="/tag/:date/schreiben" element={<WritePage />} />
          <Route path="*" element={<p>woanders</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await until(ready, 'the page opening')
  await idle()
}

function title(): HTMLTextAreaElement {
  return box.querySelector<HTMLTextAreaElement>('textarea[aria-label="Überschrift"]')!
}

function type(field: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Text typed into the editor, the way the browser puts it into the page (ProseMirror reads it from there). */
async function typeInEditor(text: string): Promise<void> {
  const paragraph = box.querySelector('[contenteditable] p')!
  await act(async () => {
    if (paragraph.firstChild && paragraph.firstChild.nodeType === Node.TEXT_NODE) paragraph.firstChild.textContent = text
    else paragraph.replaceChildren(document.createTextNode(text))
    await Promise.resolve()
  })
}

function button(text: string): HTMLButtonElement {
  return [...box.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)!
}

function saveButtons(): HTMLButtonElement[] {
  return [...box.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent?.includes('Speichern') && !item.textContent.includes('Fassung'))
}

const puts = () => calls.filter((call) => call.method === 'PUT' && call.url === `/api/days/${DATE}`)
const drafts = () => calls.filter((call) => call.method === 'PUT' && call.url.endsWith('/draft'))
const asked = () => calls.filter((call) => call.url === '/api/ai/formulate')

beforeEach(async () => {
  await changeLanguage('de', false)
  day = null
  draft = null
  meanwhile = null
  photos = []
  pool = []
  dayNotes = []
  sharedWith = []
  draftGate = null
  seenState = 'unset'
  aiState = { provider: 'local', to: '', model: 'llama3.1:8b', mine: true, available: true }
  suggestion = { title: 'Kastanien', text: 'Am Abend habe ich mit Mia Kastanien gesammelt.' }
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('writing a day up', () => {
  it('opens the page of the day and saves it once, however often Save is clicked, with only what changed', async () => {
    day = page({ title: 'Kastanien', text: 'Die Nacht war kurz.', tags: ['herbst'], revision: 3 })
    await show()
    expect(title().value).toBe('Kastanien')
    expect(box.querySelector('[contenteditable]')!.textContent).toBe('Die Nacht war kurz.')
    type(title(), 'Kastanien im Park')
    const [first] = saveButtons()
    await act(async () => {
      first.click()
      first.click()
      saveButtons()[1].click()
    })
    await idle()
    expect(puts()).toHaveLength(1)
    // The title changed here; the cover goes along while none was chosen (a page always has one); nothing else.
    expect(puts()[0].body).toEqual({ title: 'Kastanien im Park', cover: 'illu:baum.abend.herbst', base_revision: 3 })
    expect(box.textContent).toContain('woanders')
  })

  it('makes a new page savable with its first letter, at once', async () => {
    await show()
    expect(saveButtons()[0].disabled).toBe(true)
    await typeInEditor('E')
    expect(saveButtons()[0].disabled).toBe(false)
    await act(async () => saveButtons()[0].click())
    await idle()
    expect(puts()[0].body).toEqual({ text: 'E', cover: 'illu:baum.abend.herbst', written_by: 'self', base_revision: -1 })
  })

  it('keeps a draft while typing and brings it back when the page opens again', async () => {
    await show()
    type(title(), 'Halb fertig')
    // The draft goes out after a pause in the typing: that is the event waited for.
    await until(() => drafts().length === 1, 'the draft')
    await idle()
    expect(drafts()).toHaveLength(1)
    expect(drafts()[0].body).toEqual({ title: 'Halb fertig', text: '', tags: [], cover: null, base_revision: -1 })
    expect(box.textContent).toContain('Entwurf gesichert')
    act(() => root.unmount())
    box.remove()
    await show()
    expect(title().value).toBe('Halb fertig')
    expect(box.textContent).toMatch(/Dein Entwurf von \d\d:\d\d ist wieder da\./)
  })

  it('sends the draft when the page is left, before the pause in typing is over', async () => {
    await show()
    type(title(), 'Gleich weg')
    await act(async () => away.leave())
    await idle()
    expect(box.textContent).toContain('woanders')
    expect(drafts().map((call) => call.body!.title)).toEqual(['Gleich weg'])
    expect(drafts()[0].keepalive).toBe(false)
  })

  it('sends a draft with a hidden page by keepalive while it is small, as an ordinary request when it is large', async () => {
    await show()
    const hide = async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      await idle()
    }
    type(title(), 'Klein')
    await hide()
    type(title(), 'G'.repeat(70_000).slice(0, 200))
    await typeInEditor('x'.repeat(70_000))
    await hide()
    expect(drafts().map((call) => call.keepalive)).toEqual([true, false])
  })

  it('does not overwrite a field changed meanwhile on another device; the other version stands there to copy', async () => {
    day = page({ title: 'Morgens', text: 'Vom Laptop.', revision: 0 })
    await show()
    meanwhile = page({ title: 'Von dort', text: 'Vom Handy, später.', revision: 1 })
    type(title(), 'Abends')
    await act(async () => saveButtons()[0].click())
    await idle()
    expect(box.textContent).toContain('Dieser Tag wurde inzwischen auf einem anderen Gerät geändert.')
    expect(box.querySelector('[data-other-version]')!.textContent).toBe('Von dort\n\nVom Handy, später.')
    expect(day!.title).toBe('Von dort')
    await act(async () => button('Meine Fassung speichern').click())
    await idle()
    expect(puts().map((call) => call.body!.base_revision)).toEqual([0, 1])
    // Only the title was changed here: the text from the other device stays.
    expect(day!.title).toBe('Abends')
    expect(day!.text).toBe('Vom Handy, später.')
  })

  it('loads the other version instead, when asked', async () => {
    day = page({ title: 'Morgens', text: 'Vom Laptop.', revision: 0 })
    await show()
    meanwhile = page({ title: 'Von dort', text: 'Vom Handy, später.', revision: 1 })
    type(title(), 'Abends')
    await act(async () => saveButtons()[0].click())
    await idle()
    await act(async () => button('Die andere Fassung laden').click())
    await idle()
    expect(title().value).toBe('Von dort')
    expect(box.querySelector('[contenteditable]')!.textContent).toBe('Vom Handy, später.')
    expect(puts()).toHaveLength(1)
  })

  it('keeps tags set meanwhile elsewhere when only the title changed here', async () => {
    day = page({ title: 'Morgens', text: 'Vom Laptop.', tags: ['herbst'], revision: 0 })
    await show()
    // Tags and a rating on "Today" in another tab: the revision moves on, title and text stay.
    meanwhile = page({ title: 'Morgens', text: 'Vom Laptop.', tags: ['herbst', 'familie'], values: { v1: 7 }, revision: 1 })
    type(title(), 'Abends')
    await act(async () => saveButtons()[0].click())
    await idle()
    expect(box.textContent).not.toContain('Dieser Tag wurde inzwischen')
    expect(puts().map((call) => call.body!.base_revision)).toEqual([0, 1])
    expect(puts()[1].body).not.toHaveProperty('tags')
    expect(day!.title).toBe('Abends')
    expect(day!.tags).toEqual(['herbst', 'familie'])
  })

  it('saves the last words typed, even when Save comes right after them', async () => {
    day = page({ title: 'Kastanien', text: 'Die Nacht war kurz.', revision: 0 })
    await show()
    await typeInEditor('Die Nacht war kurz. Gerade getippt.')
    await act(async () => saveButtons()[0].click())
    await idle()
    expect(puts()[0].body!.text).toBe('Die Nacht war kurz. Gerade getippt.')
  })

  it('deletes an own photo from the cover picker after asking, and falls back to the suggestion', async () => {
    photos = [{ id: PHOTO, date: DATE, source: 'upload', width: 10, height: 10, created_at: '2026-10-06T17:00:00+00:00' }]
    day = page({ title: 'Mit Foto', text: 'Text.', cover: `photo:${PHOTO}`, cover_chosen: true, revision: 0 })
    await show()
    expect(box.querySelector('article img')!.getAttribute('src')).toBe(`/api/photos/${PHOTO}`)
    await act(async () => button('Titelbild ändern').click())
    await act(async () => button('Foto löschen').click())
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    expect(box.textContent).toContain('Foto löschen?')
    await act(async () => button('Löschen').click())
    await idle()
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.url)).toEqual([`/api/photos/${PHOTO}`])
    expect(box.querySelector(`img[src^="/api/photos/${PHOTO}"]`)).toBeNull()
    await act(async () => button('Schließen').click())
    expect(box.querySelector('article svg[role=img]')).not.toBeNull()
  })

  it('asks the AI only on the press of the button that led here, once, and the suggestion becomes the writing', async () => {
    await show({ formulate: 'short' })
    await idle()
    expect(asked()).toHaveLength(1)
    expect(asked()[0].body).toEqual({ date: DATE, length: 'short' })
    expect(title().value).toBe('Kastanien')
    expect(box.querySelector('[contenteditable]')!.textContent).toBe('Am Abend habe ich mit Mia Kastanien gesammelt.')
    expect(box.textContent).toContain('Ein Vorschlag. Ändere, was nicht nach dir klingt.')
    // The draft keeps how the writing came about; saved, the page counts as written with the AI.
    await eventually(() => expect(drafts().at(-1)?.body).toMatchObject({ title: 'Kastanien', written_by: 'ai', ai_length: 'short' }), 'the draft')
    await act(async () => saveButtons()[0].click())
    await idle()
    expect(puts()[0].body).toMatchObject({ title: 'Kastanien', text: 'Am Abend habe ich mit Mia Kastanien gesammelt.', written_by: 'ai', base_revision: -1 })
    expect(asked()).toHaveLength(1)
  })

  it('never asks on its own: not on opening, not for a draft begun with the AI', async () => {
    await show()
    await idle()
    expect(asked()).toHaveLength(0)
    act(() => root.unmount())
    box.remove()
    draft = { title: 'Halb', text: 'Vom Vorschlag.', tags: [], cover: null, written_by: 'ai', ai_length: 'long', base_revision: -1, updated_at: '2026-10-06T17:30:00+00:00' }
    await show()
    await idle()
    expect(asked()).toHaveLength(0)
    // Begun with the AI: "Kürzer" is offered, and only a press asks.
    expect(button('Kürzer')).toBeTruthy()
    expect(box.textContent).toContain('Ein Vorschlag.')
  })

  it('writes over a saved page only after asking: keep it, or have it written anew from all notes', async () => {
    dayNotes = [{ id: 'n1', date: DATE, text: 'kastanien nachgetragen', unreadable: false, prompt: null, prompt_id: null, photo_id: null, created_at: '2026-10-06T16:50:00+00:00', updated_at: null }]
    day = page({ title: 'Schon da', text: 'Selbst geschrieben.', revision: 2 })
    const inDialog = (text: string) => [...box.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find((item) => item.textContent?.trim() === text)!
    await show({ formulate: 'long' })
    await idle()
    expect(box.querySelector('[role=dialog]')!.textContent).toContain('Seite neu ausformulieren?')
    expect(asked()).toHaveLength(0)
    await act(async () => inDialog('Seite behalten').click())
    expect(asked()).toHaveLength(0)
    expect(title().value).toBe('Schon da')
    expect(box.querySelector('[contenteditable]')!.textContent).toBe('Selbst geschrieben.')
    // The bar offers the same for notes added later, and asks the same.
    await act(async () => button('Neu ausformulieren mit KI').click())
    expect(box.querySelector('[role=dialog]')!.textContent).toContain('Seite neu ausformulieren?')
    await act(async () => inDialog('Neu ausformulieren').click())
    await idle()
    expect(asked().map((call) => call.body)).toEqual([{ date: DATE, length: 'long' }])
    expect(title().value).toBe('Kastanien')
    // Nothing is saved over the page until Save.
    expect(puts()).toHaveLength(0)
  })

  it('offers "Neu ausformulieren" over a saved page only with notes to write from and the AI on', async () => {
    const withNote = [{ id: 'n1', date: DATE, text: 'kastanien', unreadable: false, prompt: null, prompt_id: null, photo_id: null, created_at: '2026-10-06T16:50:00+00:00', updated_at: null }]
    for (const [notes, saved, available, offered] of [[withNote, true, true, true], [[], true, true, false], [withNote, true, false, false], [withNote, false, true, false]] as const) {
      dayNotes = [...notes]
      day = saved ? page({ title: 'Tag', text: 'Geschrieben.', revision: 0 }) : null
      aiState = { provider: 'local', to: '', model: 'm', mine: available, available }
      await show()
      await idle()
      expect(Boolean(button('Neu ausformulieren mit KI'))).toBe(offered)
      act(() => root.unmount())
      box.remove()
    }
    await show()
  })

  it('asks anew for "Länger", and over changes to the suggestion only after asking', async () => {
    await show({ formulate: 'short' })
    await idle()
    suggestion = { title: 'Kastanien', text: 'Ein längerer Text über den Abend mit Mia.' }
    await act(async () => button('Länger').click())
    await idle()
    expect(asked().map((call) => call.body!.length)).toEqual(['short', 'long'])
    expect(box.querySelector('[contenteditable]')!.textContent).toBe('Ein längerer Text über den Abend mit Mia.')
    await typeInEditor('Ein längerer Text, von mir geändert.')
    // The editor reports after a pause in the typing and the page keeps a draft: when that draft holds the change, the
    // page knows it.
    await until(() => drafts().some((call) => String(call.body?.text).includes('von mir geändert')), 'the change being known to the page')
    await idle()
    await act(async () => button('Kürzer').click())
    expect(box.textContent).toContain('Neu ausformulieren?')
    expect(asked()).toHaveLength(2)
    await act(async () => button('Abbrechen').click())
    expect(asked()).toHaveLength(2)
    await act(async () => button('Kürzer').click())
    await act(async () => button('Neu schreiben').click())
    await idle()
    expect(asked().map((call) => call.body!.length)).toEqual(['short', 'long', 'short'])
  })

  it('offers no "Länger" when the person switched the AI off', async () => {
    aiState = { provider: 'local', to: '', model: '', mine: false, available: false }
    draft = { title: 'Halb', text: 'Vom Vorschlag.', tags: [], cover: null, written_by: 'ai', ai_length: 'short', base_revision: -1, updated_at: '2026-10-06T17:30:00+00:00' }
    await show()
    await idle()
    expect(button('Länger')).toBeUndefined()
  })

  it('says why a suggestion failed and leaves the page to write on', async () => {
    suggestion = 'ai_unreachable'
    await show({ formulate: 'long' })
    await idle()
    expect(box.querySelector('[role=alert]')!.textContent).toBe('Der Server erreicht den KI-Dienst nicht.')
    expect(box.querySelector('[contenteditable]')).not.toBeNull()
    expect(title().value).toBe('')
  })

  it('offers questions to insert, four at a time, and puts a tapped one in as a subheading', async () => {
    pool = ['eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs'].map((word, index) => ({ id: `schoen.${index}`, text: `Frage ${word}?`, answered: false }))
    day = page({ title: 'Tag', text: 'Erster Absatz.', revision: 0 })
    await show()
    await idle()
    expect(box.textContent).toContain('Weiterschreiben?')
    const shown = () => [...box.querySelectorAll('aside li button')].map((item) => item.textContent)
    expect(shown()).toEqual(['Frage drei?', 'Frage vier?', 'Frage fünf?', 'Frage sechs?'])
    await act(async () => button('Andere Fragen').click())
    expect(shown()).toEqual(['Frage eins?', 'Frage zwei?', 'Frage drei?', 'Frage vier?'])
    await act(async () => button('Frage zwei?').click())
    await idle()
    expect(box.querySelector('[contenteditable] h2')!.textContent).toBe('Frage zwei?')
  })

  it('shows no questions when the person switched them off', async () => {
    pool = []
    await show()
    await idle()
    expect(box.textContent).not.toContain('Weiterschreiben?')
  })

  it('forgets the press that led here at once: the history state is cleared, a reload asks nothing', async () => {
    await show({ formulate: 'long' })
    await idle()
    expect(asked()).toHaveLength(1)
    expect(seenState).toBeNull()
  })

  it('offers "Ausformulieren" above the text of a day with notes and no page, and asks only on the press', async () => {
    dayNotes = [{ id: 'n1', date: DATE, text: 'kastanien gesammelt', unreadable: false, prompt: null, prompt_id: null, photo_id: null, created_at: '2026-10-06T16:50:00+00:00', updated_at: null }]
    await show()
    await idle()
    const offer = box.querySelector('[data-offer-ai]')!
    expect(offer.textContent).toContain('Wird mit dem lokalen Modell eures Servers formuliert. Nichts verlässt das Haus.')
    expect(asked()).toHaveLength(0)
    await act(async () => [...offer.querySelectorAll<HTMLButtonElement>('[role=radio]')].find((item) => item.textContent === 'kurz')!.click())
    await act(async () => button('Ausformulieren mit KI').click())
    await idle()
    expect(asked().map((call) => call.body)).toEqual([{ date: DATE, length: 'short' }])
    expect(box.querySelector('[data-offer-ai]')).toBeNull()
    expect(title().value).toBe('Kastanien')
  })

  it('offers it neither over a saved page, nor without notes, nor with the AI off', async () => {
    const withNote = [{ id: 'n1', date: DATE, text: 'kastanien', unreadable: false, prompt: null, prompt_id: null, photo_id: null, created_at: '2026-10-06T16:50:00+00:00', updated_at: null }]
    for (const [notes, saved, available] of [[withNote, true, true], [[], false, true], [withNote, false, false]] as const) {
      dayNotes = [...notes]
      day = saved ? page({ title: 'Tag', text: 'Geschrieben.', revision: 0 }) : null
      aiState = { provider: 'local', to: '', model: 'm', mine: available, available }
      await show()
      await idle()
      expect(box.querySelector('[data-offer-ai]')).toBeNull()
      act(() => root.unmount())
      box.remove()
    }
    await show()
  })

  it('asks before writing over a draft: keep it, or have it written anew', async () => {
    dayNotes = [{ id: 'n1', date: DATE, text: 'kastanien', unreadable: false, prompt: null, prompt_id: null, photo_id: null, created_at: '2026-10-06T16:50:00+00:00', updated_at: null }]
    draft = { title: 'Mein Entwurf', text: 'Selbst angefangen.', tags: [], cover: null, base_revision: -1, updated_at: '2026-10-06T17:30:00+00:00' }
    await show({ formulate: 'long' })
    await idle()
    expect(box.textContent).toContain('Entwurf behalten?')
    expect(asked()).toHaveLength(0)
    await act(async () => button('Entwurf behalten').click())
    expect(title().value).toBe('Mein Entwurf')
    expect(asked()).toHaveLength(0)
    // The button above the text asks the same.
    await act(async () => button('Ausformulieren mit KI').click())
    expect(box.textContent).toContain('Entwurf behalten?')
    await act(async () => button('Neu ausformulieren').click())
    await idle()
    expect(asked()).toHaveLength(1)
    expect(title().value).toBe('Kastanien')
  })

  it('keeps the title one line that wraps: no line break in it, Enter goes on to the text', async () => {
    await show()
    type(title(), 'Erste Zeile\nzweite Zeile')
    expect(title().value).toBe('Erste Zeile zweite Zeile')
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => {
      title().dispatchEvent(enter)
    })
    expect(enter.defaultPrevented).toBe(true)
    expect(title().tagName).toBe('TEXTAREA')
  })
})

describe('the bar at the top, Ctrl+S, and locking', () => {
  it('keeps the top bar and the bar of formats together in one bar that stays in view', async () => {
    day = page({ title: 'Kastanien', text: 'Die Nacht war kurz.', revision: 3 })
    await show()
    const bar = box.querySelector('[data-write-bar]')!
    expect(bar.className).toContain('sticky')
    expect(bar.className).toContain('top-0')
    // Back, Save and the formats are all in it; the text is not.
    expect(bar.querySelector('[role=toolbar]')).not.toBeNull()
    expect([...bar.querySelectorAll('button')].some((item) => item.textContent?.trim() === 'Speichern')).toBe(true)
    expect(bar.textContent).toContain('Zurück zu den Notizen')
    expect(bar.querySelector('[contenteditable]')).toBeNull()
    expect(bar.querySelector('textarea')).toBeNull()
  })

  it.each([
    ['Ctrl+S', { key: 's', ctrlKey: true }],
    ['Cmd+S', { key: 'S', metaKey: true }],
  ])('saves on %s, once, and keeps the browser from saving the page', async (_name, keys) => {
    day = page({ title: 'Kastanien', text: 'Die Nacht war kurz.', revision: 3 })
    await show()
    type(title(), 'Kastanien im Park')
    const first = new KeyboardEvent('keydown', { ...keys, bubbles: true, cancelable: true })
    await act(async () => {
      window.dispatchEvent(first)
      window.dispatchEvent(new KeyboardEvent('keydown', { ...keys, bubbles: true, cancelable: true }))
    })
    await idle()
    expect(first.defaultPrevented).toBe(true)
    expect(puts()).toHaveLength(1)
    expect(puts()[0].body).toMatchObject({ title: 'Kastanien im Park', base_revision: 3 })
  })

  it('does not save on Ctrl+S while there is nothing to save, but still keeps the browser from saving the page', async () => {
    await show()
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    await act(async () => window.dispatchEvent(event))
    await idle()
    expect(event.defaultPrevented).toBe(true)
    expect(puts()).toHaveLength(0)
    // Other keys and other letters are left alone.
    const other = [new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true }), new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })]
    await act(async () => other.forEach((key) => window.dispatchEvent(key)))
    expect(other.map((key) => key.defaultPrevented)).toEqual([false, false])
  })

  it('offers to lock a saved page, after the changes are saved', async () => {
    day = page({ title: 'Kastanien', text: 'Die Nacht war kurz.', revision: 3 })
    await show()
    const lock = button('Für immer verschließen')
    expect(lock.disabled).toBe(false)
    type(title(), 'Kastanien im Park')
    expect(button('Für immer verschließen').disabled).toBe(true)
    expect(button('Für immer verschließen').title).toBe('Speichere zuerst deine Änderungen, dann lässt sich der Tag verschließen.')
  })

  it('has no lock for a page that was never saved', async () => {
    await show()
    await typeInEditor('Ein Anfang')
    expect([...box.querySelectorAll('button')].some((item) => item.textContent?.includes('verschließen'))).toBe(false)
  })

  it('locks only after the word is typed, then leaves for the day', async () => {
    day = page({ title: 'Kastanien', text: 'Die Nacht war kurz.', revision: 3 })
    await show()
    await act(async () => button('Für immer verschließen').click())
    const dialog = document.querySelector('[role=dialog]')!
    expect(dialog.textContent).toContain('nie mehr ändern oder löschen')
    expect(dialog.textContent).toContain('auch nicht von dir und nicht vom Betreiber')
    const confirm = [...dialog.querySelectorAll('button')].find((item) => item.textContent?.includes('Für immer verschließen'))!
    expect(confirm.disabled).toBe(true)
    const input = dialog.querySelector('input')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const write = (value: string) =>
      act(() => {
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    write('verschließ')
    expect(confirm.disabled).toBe(true)
    write('Verschließen')
    expect(confirm.disabled).toBe(false)
    expect(calls.some((call) => call.url.endsWith('/lock'))).toBe(false)
    await act(async () => confirm.click())
    await idle()
    expect(calls.filter((call) => call.url.endsWith('/lock'))).toHaveLength(1)
    expect(box.textContent).toContain('woanders')
  })

  it('shows a locked day as one to read, with no editor, no save and no lock', async () => {
    day = page({ title: 'Kastanien', text: 'Die Nacht war kurz.', revision: 3, locked: true })
    await show()
    expect(box.querySelector('[contenteditable]')).toBeNull()
    expect(box.textContent).toContain('Dieser Tag ist verschlossen. Er lässt sich nicht mehr ändern.')
    expect(saveButtons()).toHaveLength(0)
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    await act(async () => window.dispatchEvent(event))
    expect(puts()).toHaveLength(0)
    expect(box.querySelector('a')!.getAttribute('href')).toBe(`/tag/${DATE}`)
  })
})

describe('a draft older than the saved page', () => {
  const stale = () => document.querySelector('[data-stale-draft]')
  const choice = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find((item) => item.textContent?.trim() === text)!

  beforeEach(() => {
    // Begun on revision 1; "Nur kurz" or another tab saved the page since (revision 3).
    day = page({ title: 'Nur kurz', text: 'Müde.', revision: 3 })
    draft = { title: 'Langer Entwurf', text: 'Am Morgen war es neblig.', tags: [], cover: null, base_revision: 1, updated_at: '2026-10-06T17:30:00+00:00' }
  })

  it('asks which one to edit, and the saved page throws the draft away', async () => {
    await show(null, stale)
    expect(document.querySelector('[role=dialog]')!.getAttribute('aria-label')).toBe('Seite oder Entwurf?')
    expect(stale()!.textContent).toBe('Seit diesem Entwurf wurde der Tag gespeichert. Welche Fassung willst du bearbeiten?')
    // Nothing of either is on the page while the question stands, and no draft goes out.
    expect(box.querySelector('[contenteditable]')).toBeNull()
    // Not from today: with its date.
    expect(choice('Entwurf vom 6. Oktober, 19:30')).toBeTruthy()
    await act(async () => choice('Gespeicherte Seite').click())
    await until(() => box.querySelector('[contenteditable]'), 'the editor')
    await idle()
    expect(title().value).toBe('Nur kurz')
    expect(box.textContent).not.toContain('ist wieder da')
    expect(calls.filter((call) => call.method === 'DELETE' && call.url === `/api/days/${DATE}/draft`)).toHaveLength(1)
    expect(drafts()).toHaveLength(0)
  })

  it('brings the draft back when chosen, and a save meets the page saved since', async () => {
    await show(null, stale)
    await act(async () => choice('Entwurf vom 6. Oktober, 19:30').click())
    await until(() => box.querySelector('[contenteditable]'), 'the editor')
    await idle()
    expect(title().value).toBe('Langer Entwurf')
    expect(box.textContent).toContain('Dein Entwurf von 19:30 ist wieder da.')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    await act(async () => saveButtons()[0].click())
    await idle()
    // Saved onto the revision the draft began on: refused, and the other version stands there to copy.
    expect(puts().map((call) => call.body!.base_revision)).toEqual([1])
    expect(box.textContent).toContain('Dieser Tag wurde inzwischen auf einem anderen Gerät geändert.')
    expect(day!.text).toBe('Müde.')
  })

  it('names only the time for a draft of today', async () => {
    const now = new Date()
    draft = { ...draft!, updated_at: now.toISOString() }
    await show(null, stale)
    const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(now)
    expect(choice(`Entwurf von ${time}`)).toBeTruthy()
  })

  it('comes back without asking when it was begun on the page that stands', async () => {
    draft = { ...draft!, base_revision: 3 }
    await show()
    expect(stale()).toBeNull()
    expect(title().value).toBe('Langer Entwurf')
  })

  it('comes back without asking over a day that holds no page, only ratings', async () => {
    day = page({ title: '', text: '', revision: 2, values: { v1: 4 } })
    await show()
    expect(stale()).toBeNull()
    expect(title().value).toBe('Langer Entwurf')
  })
})

describe('deleting the page', () => {
  it('asks first, says what stays and who loses the share, then leaves the writing page', async () => {
    day = page({ title: 'Versehen', text: 'Nur kurz.', revision: 2 })
    sharedWith = [{ id: 7, name: 'tom', display_name: 'Tom', avatar: null, with_values: false, with_notes: false, heart: null }]
    await show()
    await act(async () => button('Seite löschen').click())
    await idle()
    const dialog = document.querySelector('[role=dialog]')!
    expect(dialog.getAttribute('aria-label')).toBe('Seite löschen?')
    expect(dialog.textContent).toContain('Deine Notizen und die Fotos des Tages bleiben')
    expect(dialog.querySelector('[data-delete-shared]')!.textContent).toBe('Geteilt ist der Tag dann nicht mehr: Tom sieht ihn nicht mehr.')
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    await act(async () => [...dialog.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Löschen')!.click())
    await idle()
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.url)).toEqual([`/api/days/${DATE}`])
    expect(box.textContent).toContain('woanders')
    // Nothing went out as a draft afterwards.
    expect(drafts()).toHaveLength(0)
  })

  it('waits for a draft on its way before it deletes, and sends none after', async () => {
    day = page({ title: 'Versehen', text: 'Nur kurz.', revision: 2 })
    let release: () => void = () => undefined
    draftGate = new Promise<void>((resolve) => {
      release = resolve
    })
    await show()
    type(title(), 'Doch anders')
    await until(() => drafts().length === 1, 'the draft on its way')
    await act(async () => button('Seite löschen').click())
    const go = () => [...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find((item) => item.textContent?.trim() === 'Löschen')
    // Ready once it knows who the day is shared with (the draft is still held, so no waiting for all requests).
    await until(() => go() && !go()!.disabled, 'the question')
    await act(async () => go()!.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    await act(async () => release())
    await until(() => calls.some((call) => call.method === 'DELETE'), 'the delete')
    await idle()
    const order = calls.filter((call) => call.method === 'DELETE' || (call.method === 'PUT' && call.url.endsWith('/draft'))).map((call) => call.method)
    expect(order).toEqual(['PUT', 'DELETE'])
    expect(box.textContent).toContain('woanders')
  })

  it('warns that changes not saved go too, and is not there for a page never saved or a locked day', async () => {
    day = page({ title: 'Versehen', text: 'Nur kurz.', revision: 2 })
    await show()
    type(title(), 'Doch anders')
    await act(async () => button('Seite löschen').click())
    await idle()
    const dialog = document.querySelector('[role=dialog]')!
    expect(dialog.textContent).toContain('Was du hier noch nicht gespeichert hast, geht auch verloren.')
    await act(async () => [...dialog.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Löschen')!.click())
    await idle()
    expect(box.textContent).toContain('woanders')
    // What was typed and not saved does not come back as a draft over the deleted page.
    expect(drafts()).toHaveLength(0)
    act(() => root.unmount())
    box.remove()
    day = null
    await show()
    expect(button('Seite löschen')).toBeUndefined()
    act(() => root.unmount())
    box.remove()
    day = page({ title: 'Fest', text: 'Bleibt.', revision: 2, locked: true })
    await show()
    expect(button('Seite löschen')).toBeUndefined()
  })
})

describe('"Erst fragen lassen" in the bar', () => {
  it('says what it does when pointed at, on a saved page with notes', async () => {
    day = page({ title: 'Kastanien', text: 'Die Nacht war kurz.', revision: 3 })
    dayNotes = [{ id: 'n1', date: DATE, text: 'kastanien', prompt: null, created_at: '2026-10-06T16:00:00+00:00', photo_id: null, unreadable: false }]
    await show()
    expect(button('Erst fragen lassen').title).toBe('Die KI stellt dir bis zu zwei Fragen zu dem, was in deinen Notizen offen bleibt. Deine Antworten kommen zu den Notizen, dann schreibt sie die Seite.')
  })
})
