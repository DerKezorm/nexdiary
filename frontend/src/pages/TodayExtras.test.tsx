/**
 * The new parts of "Today" against a server stand-in, in all three layouts: the family question (before the own
 * answer only who answered, after it the answers; the quiet hint for whoever has not joined), "Erst fragen lassen"
 * (the questions of the AI, the answers as notes with their question, then the writing page as after "Ausformulieren")
 * and "Heute nur kurz" (the first value and one sentence make the page of today, only while there is none).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

import type { FamilyCard, Profile } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { TodayPage } from './TodayPage'
import { eventually, idle } from '../test/wait'

const me: { name: string; display_name: string; profile: Profile } = {
  name: 'jule',
  display_name: 'Jule',
  profile: { palette: 'salbei', mode: 'system', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true },
}
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))

const DATE = '2026-10-06'
const NOTES = [
  { id: 'a0000000-0000-4000-8000-000000000001', date: DATE, text: 'lena fand die idee mit dem board gut', unreadable: false, prompt: null, prompt_id: null, photo_id: null, created_at: '2026-10-06T07:40:00+00:00', updated_at: null },
  { id: 'a0000000-0000-4000-8000-000000000002', date: DATE, text: 'kastanien mit mia', unreadable: false, prompt: null, prompt_id: null, photo_id: null, created_at: '2026-10-06T16:50:00+00:00', updated_at: null },
]
const QUESTION = { id: 'familie.0', text: 'Was war heute das Leckerste, das du gegessen hast?' }
const PEOPLE = [
  { id: 1, name: 'jule', display_name: 'Jule', avatar: null, me: true, answered: false },
  { id: 2, name: 'tom', display_name: 'Tom', avatar: null, me: false, answered: true },
  { id: 3, name: 'ruth', display_name: 'Oma Ruth', avatar: null, me: false, answered: true },
  { id: 4, name: 'mia', display_name: 'Mia', avatar: null, me: false, answered: false },
]
const ANSWERS = [
  { from: 2, text: 'Die Kürbissuppe von gestern, aufgewärmt sogar noch besser.', at: '2026-10-06T10:31:00+00:00' },
  { from: 3, text: 'Ein Apfel vom alten Baum, direkt vom Ast.', at: '2026-10-06T13:02:00+00:00' },
]
const BEFORE: FamilyCard = { date: DATE, question: QUESTION, people: PEOPLE, mine: null, answers: null }
const VALUES = [
  { id: 'v0', name: 'Beziehung', low: 'schwierig', high: 'innig', hint: '', active: false, position: 0 },
  { id: 'v1', name: 'Stimmung', low: 'mies', high: 'super', hint: 'Wie ging es dir heute?', active: true, position: 1 },
  { id: 'v2', name: 'Schlaf', low: 'kaum', high: 'erholt', hint: '', active: true, position: 2 },
]

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let today: Record<string, unknown>
let ai: Record<string, unknown>
let family: FamilyCard | null
let followups: { questions: unknown[] } | string
/** The answer the server already holds for today (another device): a new one is refused. */
let answeredElsewhere: string | null

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url.startsWith('/api/today')) return json({ ...today, family })
      if (url === '/api/ai') return json(ai)
      if (url === '/api/family/answer' && method === 'PUT') {
        await new Promise((resolve) => setTimeout(resolve, 20))
        if (answeredElsewhere !== null) {
          family = { ...family!, mine: { text: answeredElsewhere, at: '2026-10-06T16:00:00+00:00' }, answers: ANSWERS }
          return json({ detail: { code: 'family_answered', message: 'x' } }, 409)
        }
        const mine = { text: body!.text, at: '2026-10-06T17:00:00+00:00' }
        family = { ...family!, mine, answers: ANSWERS, people: PEOPLE.map((person) => (person.me ? { ...person, answered: true } : person)) }
        today = { ...today, notes: [...(today.notes as unknown[]), { ...NOTES[1], id: body!.note_id, text: body!.text, prompt: QUESTION.text, prompt_id: QUESTION.id }] }
        return json(family)
      }
      if (url.startsWith('/api/family/answer') && method === 'DELETE') {
        family = BEFORE
        return json(family)
      }
      if (url === '/api/me/preferences') return json({ ...me.profile, ...body })
      if (url === '/api/ai/followups') {
        await new Promise((resolve) => setTimeout(resolve, 20))
        if (typeof followups === 'string') return json({ detail: { code: followups, message: 'x' } }, 502)
        return json(followups)
      }
      if (url === '/api/notes' && method === 'POST') return json({ ...NOTES[0], id: body!.id, text: body!.text, prompt: body!.prompt ?? null }, 201)
      if (url === `/api/days/${DATE}/short`) {
        today = { ...today, streak: 5 }
        return json({ date: DATE, title: body!.text, text: body!.text, tags: [], values: {}, cover: body!.cover, cover_chosen: true, written_by: 'self', words: 3, revision: 0, created_at: '', updated_at: '' })
      }
      return json([])
    }),
  )
}

/** The short entry refused: a note came in on another device meanwhile. */
function serveShortRefused(): void {
  const before = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === `/api/days/${DATE}/short`) return new Response(JSON.stringify({ detail: { code: 'short_day_not_empty', message: 'x' } }), { status: 409, headers: { 'Content-Type': 'application/json' } })
      return before(url, init)
    }),
  )
}

let root: Root
let box: HTMLDivElement

/** Where a press leads: the writing page or the page of the day, showing what it was handed. */
function Landed() {
  const location = useLocation()
  return (
    <p data-landed={location.pathname}>{JSON.stringify(location.state)}</p>
  )
}

async function show(layout: Profile['layout'] = 'page'): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  me.profile = { ...me.profile, layout }
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<TodayPage now={new Date(Date.UTC(2026, 9, 6, 17, 30))} />} />
          <Route path="/tag/:date/schreiben" element={<Landed />} />
          <Route path="/tag/:date" element={<Landed />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  await idle()
}

function close(): void {
  act(() => root.unmount())
  box.remove()
}

function button(text: string, inside: ParentNode = box): HTMLButtonElement | undefined {
  return [...inside.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)
}

function type(field: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    setter.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>('[role=dialog]')!
}

beforeEach(async () => {
  await changeLanguage('de', false)
  Element.prototype.scrollTo = vi.fn()
  today = { date: DATE, notes: [...NOTES], day: null, values: VALUES, streak: 4, photos: [], question: null, family_hint: false }
  ai = { provider: 'local', to: '', model: 'llama3.1:8b', mine: true, available: true }
  family = BEFORE
  followups = { questions: [] }
  answeredElsewhere = null
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('the family question', () => {
  it.each(['page', 'columns', 'chat'] as const)('shows who answered and nothing of what before the own answer, layout %s', async (layout) => {
    await show(layout)
    const card = box.querySelector('[data-family]')!
    expect(card.querySelector('[data-family-question]')!.textContent).toBe(QUESTION.text)
    expect(card.textContent).toContain('Tom und Oma Ruth haben schon geantwortet. Du siehst die Antworten, sobald du selbst antwortest.')
    expect(card.textContent).not.toContain('Kürbissuppe')
    // The others as faces: who answered in full, who has not yet pale; the own face is not among them.
    expect([...card.querySelectorAll('[role=listitem]')].map((item) => item.getAttribute('data-answered'))).toEqual(['true', 'true', 'false'])
    expect(card.querySelectorAll('[data-placeholders] > div')).toHaveLength(2)
    // It stands below the question of the day's place, before the notes in the page layout.
    if (layout === 'page') expect(card.compareDocumentPosition(box.querySelector('ol, [data-before]') ?? box.lastChild!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it.each(['page', 'columns', 'chat'] as const)('opens the answers after the own one, which becomes a note too, layout %s', async (layout) => {
    await show(layout)
    const card = box.querySelector('[data-family]')!
    type(card.querySelector<HTMLTextAreaElement>('textarea[aria-label="Deine Antwort auf die Familienfrage"]')!, 'Kastanien, geröstet.')
    await act(async () => button('Antworten', card)!.click())
    await idle()
    const sent = calls.filter((call) => call.url === '/api/family/answer')
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toMatchObject({ date: DATE, text: 'Kastanien, geröstet.' })
    expect(String(sent[0].body!.note_id)).toMatch(/^[0-9a-f-]{36}$/)
    const after = box.querySelector('[data-family]')!
    expect(after.querySelector('[data-answers]')!.textContent).toContain('Die Kürbissuppe von gestern, aufgewärmt sogar noch besser.')
    expect(after.querySelector('[data-answers]')!.textContent).toContain('Oma Ruth')
    expect(after.querySelector('[data-mine] p')!.textContent).toBe('Kastanien, geröstet.')
    expect(after.textContent).toContain('Mia hat noch nicht geantwortet. Deine Antwort steht auch in deinen Notizen.')
    // The day was loaded again: the note with its question stands among the notes.
    expect(box.textContent).toContain('Kastanien, geröstet.')
  })

  it('sends one note id for a double Enter, and a new one for the next answer', async () => {
    await show()
    const field = box.querySelector<HTMLTextAreaElement>('textarea[aria-label="Deine Antwort auf die Familienfrage"]')!
    type(field, 'Suppe')
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await idle()
    const ids = calls.filter((call) => call.url === '/api/family/answer').map((call) => call.body!.note_id)
    expect(new Set(ids).size).toBe(1)
    // An answer is final: nothing to take back, nothing to change, and the card said so under the field.
    expect(button('Zurücknehmen')).toBeUndefined()
    expect(button('Ändern')).toBeUndefined()
    expect(box.querySelector('textarea[aria-label="Deine Antwort auf die Familienfrage"]')).toBeNull()
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    expect(box.querySelector('[data-answers]')).not.toBeNull()
  })

  it.each(['page', 'columns', 'chat'] as const)('says under the field that an answer cannot be changed, layout %s', async (layout) => {
    await show(layout)
    const card = box.querySelector('[data-family]')!
    expect(card.querySelector('[data-family-final]')!.textContent).toBe('Deine Antwort lässt sich danach nicht mehr ändern.')
  })

  it('shows the answer that stands when another device answered first', async () => {
    answeredElsewhere = 'Suppe vom Handy'
    await show()
    type(box.querySelector<HTMLTextAreaElement>('textarea[aria-label="Deine Antwort auf die Familienfrage"]')!, 'Brot')
    await act(async () => button('Antworten')!.click())
    await idle()
    const card = box.querySelector('[data-family]')!
    expect(card.querySelector('[role=alert]')!.textContent).toBe('Du hast diese Frage schon beantwortet. Eine Antwort bleibt, wie sie ist.')
    expect(card.querySelector('[data-mine] p')!.textContent).toBe('Suppe vom Handy')
  })

  it('says so when nobody answered yet, and is not there for whoever has not joined', async () => {
    family = { ...BEFORE, people: PEOPLE.map((person) => ({ ...person, answered: false })) }
    await show()
    expect(box.querySelector('[data-family]')!.textContent).toContain('Noch hat niemand geantwortet.')
    close()
    family = null
    await show()
    expect(box.querySelector('[data-family]')).toBeNull()
    expect(box.querySelector('[data-family-hint]')).toBeNull()
  })

  it.each(['page', 'columns', 'chat'] as const)('tells once and quietly that others take part, layout %s', async (layout) => {
    family = null
    today = { ...today, family_hint: true }
    await show(layout)
    const hint = box.querySelector('[data-family-hint]')!
    expect(hint.textContent).toContain('Bei euch gibt es die Familienfrage')
    await act(async () => button('Nicht mehr zeigen', hint)!.click())
    await idle()
    expect(calls.filter((call) => call.url === '/api/me/preferences').map((call) => call.body)).toEqual([{ family_hint: false }])
    expect(box.querySelector('[data-family-hint]')).toBeNull()
  })

  it('joins from the hint and shows the card', async () => {
    family = null
    today = { ...today, family_hint: true }
    await show()
    await act(async () => {
      family = BEFORE
      button('Mitmachen')!.click()
    })
    await idle()
    expect(calls.filter((call) => call.url === '/api/me/preferences').map((call) => call.body)).toEqual([{ family: true }])
    expect(box.querySelector('[data-family]')).not.toBeNull()
  })
})

describe('the AI asks first', () => {
  it.each(['page', 'columns', 'chat'] as const)('stands under "Ausformulieren" only with an AI and notes, layout %s', async (layout) => {
    await show(layout)
    expect(button('Erst fragen lassen')).toBeTruthy()
    // Said right under it what it does; the promise about the notes stays below.
    const explain = box.querySelector('[data-followups-explain]')!
    expect(explain.textContent).toBe('Die KI stellt dir bis zu zwei Fragen zu dem, was in deinen Notizen offen bleibt. Deine Antworten kommen zu den Notizen, dann schreibt sie die Seite.')
    expect(explain.previousElementSibling!.textContent).toContain('Erst fragen lassen')
    expect(explain.nextElementSibling!.textContent).toContain('Die KI ordnet und glättet nur')
    expect(calls.some((call) => call.url.startsWith('/api/ai/'))).toBe(false)
    close()
    ai = { provider: 'none', to: '', model: '', mine: true, available: false }
    await show(layout)
    expect(button('Erst fragen lassen')).toBeUndefined()
    expect(box.querySelector('[data-followups-explain]')).toBeNull()
  })

  it('asks, keeps the answers as notes with their question, passes over the empty ones and writes the day up', async () => {
    followups = {
      questions: [
        { question: 'Du schreibst, Lena fand die Idee mit dem Board gut. Was war die Idee?', note_id: NOTES[0].id, at: NOTES[0].created_at },
        { question: 'Wo habt ihr die Kastanien gesammelt?', note_id: NOTES[1].id, at: NOTES[1].created_at },
      ],
    }
    await show()
    await act(async () => button('Erst fragen lassen')!.click())
    expect(dialog().textContent).toContain('Liest deine Notizen')
    expect(dialog().querySelector('[data-followups-explain]')!.textContent).toContain('Die KI stellt dir bis zu zwei Fragen')
    await eventually(() => expect(dialog().textContent).toContain('Was war die Idee?'), 'the questions')
    // The time of the note in the person's zone: 07:40 UTC is 09:40 in Berlin.
    expect(dialog().textContent).toContain('zur Notiz von 09:40 Uhr')
    expect(dialog().textContent).toContain('zur Notiz von 18:50 Uhr')
    expect(calls.filter((call) => call.url === '/api/ai/followups').map((call) => call.body)).toEqual([{ date: DATE }])
    type(dialog().querySelectorAll('textarea')[0], 'Ein Board für die Wochenplanung.')
    await act(async () => button('Ausformulieren', dialog())!.click())
    await idle()
    const notes = calls.filter((call) => call.url === '/api/notes' && call.method === 'POST')
    expect(notes.map((call) => [call.body!.text, call.body!.prompt, call.body!.date, 'prompt_id' in call.body!])).toEqual([
      ['Ein Board für die Wochenplanung.', 'Du schreibst, Lena fand die Idee mit dem Board gut. Was war die Idee?', DATE, false],
    ])
    expect(box.querySelector('[data-landed]')!.getAttribute('data-landed')).toBe(`/tag/${DATE}/schreiben`)
    expect(box.querySelector('[data-landed]')!.textContent).toBe('{"formulate":"long"}')
  })

  it('goes on without answers, and says so when nothing is open', async () => {
    followups = { questions: [{ question: 'Mit wem?', note_id: NOTES[1].id, at: NOTES[1].created_at }] }
    await show()
    await act(async () => button('Erst fragen lassen')!.click())
    await eventually(() => expect(button('Ohne Antworten weiter', dialog())).toBeTruthy(), 'the questions')
    await act(async () => button('Ohne Antworten weiter', dialog())!.click())
    expect(calls.some((call) => call.url === '/api/notes' && call.method === 'POST')).toBe(false)
    expect(box.querySelector('[data-landed]')!.textContent).toBe('{"formulate":"long"}')
    close()
    followups = { questions: [] }
    await show()
    await act(async () => button('Erst fragen lassen')!.click())
    await eventually(() => expect(dialog().textContent).toContain('Zu deinen Notizen ist nichts offen.'), 'nothing open')
    expect(button('Ohne Antworten weiter', dialog())).toBeUndefined()
    await act(async () => button('Ausformulieren', dialog())!.click())
    expect(box.querySelector('[data-landed]')!.textContent).toBe('{"formulate":"long"}')
  })

  it('says what went wrong and still lets the day be written up', async () => {
    followups = 'ai_unreadable'
    await show()
    await act(async () => button('Erst fragen lassen')!.click())
    await eventually(() => expect(dialog().querySelector('[role=alert]')).not.toBeNull(), 'the error')
    expect(button('Ausformulieren', dialog())).toBeTruthy()
  })
})

describe('just briefly today', () => {
  // "Heute nur kurz" is for an empty day only: no notes, no page, no draft.
  beforeEach(() => {
    today = { ...today, notes: [] }
  })

  it.each(['page', 'columns', 'chat'] as const)('is offered on an empty day and not once there are notes, layout %s', async (layout) => {
    await show(layout)
    expect(button('Heute nur kurz: Stimmung und ein Satz')).toBeTruthy()
    close()
    today = { ...today, notes: [...NOTES] }
    await show(layout)
    expect(button('Heute nur kurz: Stimmung und ein Satz')).toBeUndefined()
    // The rest of the card stays: the day is written up instead.
    expect(box.textContent).toContain('Den Tag aufschreiben')
  })

  it('is not offered while a draft stands, nor under a title alone', async () => {
    today = { ...today, has_draft: true }
    await show()
    expect(button('Heute nur kurz: Stimmung und ein Satz')).toBeUndefined()
    close()
    today = { ...today, has_draft: false, day: { date: DATE, text: '', title: 'Nur ein Titel', tags: [], values: {}, cover: 'illu:baum.abend.herbst', cover_chosen: true } }
    await show()
    expect(button('Heute nur kurz: Stimmung und ein Satz')).toBeUndefined()
  })

  it('says why when the server finds the day no longer empty', async () => {
    await show()
    serveShortRefused()
    await act(async () => button('Heute nur kurz: Stimmung und ein Satz')!.click())
    type(dialog().querySelector<HTMLInputElement>('input')!, 'Nur kurz.')
    await act(async () => button('4 von 10', dialog())!.click())
    await act(async () => button('Speichern', dialog())!.click())
    await idle()
    expect(dialog().querySelector('[role=alert]')!.textContent).toBe('Für heute gibt es schon Notizen oder einen Entwurf. Schreib den Tag lieber auf.')
  })

  it.each(['page', 'columns', 'chat'] as const)('makes the page of today out of the first value and one sentence, layout %s', async (layout) => {
    await show(layout)
    await act(async () => button('Heute nur kurz: Stimmung und ein Satz')!.click())
    const box2 = dialog()
    expect(box2.textContent).toContain('Nur kurz heute')
    expect(box2.textContent).toContain('Titelbild ist schon ausgesucht.')
    // The first value the person rates, not the one switched off before it.
    expect(box2.querySelector('[role=group]')!.getAttribute('aria-label')).toBe('Stimmung')
    const save = button('Speichern', box2)!
    expect(save.disabled).toBe(true)
    type(box2.querySelector<HTMLInputElement>('input')!, 'Kastanien mit Mia, sonst nur müde.')
    expect(save.disabled).toBe(true)
    await act(async () => button('4 von 10', box2)!.click())
    expect(save.disabled).toBe(false)
    await act(async () => save.click())
    await idle()
    const sent = calls.filter((call) => call.url === `/api/days/${DATE}/short`)
    expect(sent.map((call) => call.body)).toEqual([
      { text: 'Kastanien mit Mia, sonst nur müde.', title: 'Dienstag, 6. Oktober', rating: 4, cover: box2.querySelector('[data-short-cover]')?.getAttribute('data-short-cover') ?? expect.stringMatching(/^illu:/) },
    ])
    expect(String(sent[0].body!.cover)).toMatch(/^illu:[a-z]+\.[a-z]+\.herbst$/)
    expect(box.querySelector('[data-landed]')!.getAttribute('data-landed')).toBe(`/tag/${DATE}`)
    expect(box.querySelector('[data-landed]')!.textContent).toBe('{"notice":"Gespeichert. Tag 5 in Folge."}')
  })

  it('takes only the sentence for a person who rates nothing', async () => {
    today = { ...today, values: VALUES.map((value) => ({ ...value, active: false })) }
    await show()
    await act(async () => button('Heute nur kurz: ein Satz')!.click())
    expect(dialog().querySelector('[role=group]')).toBeNull()
    expect(dialog().textContent).toContain('Ein Satz, und der Tag zählt für deine Serie.')
    type(dialog().querySelector<HTMLInputElement>('input')!, 'Nur ein Satz.')
    await act(async () => button('Speichern', dialog())!.click())
    await idle()
    const body = calls.find((call) => call.url === `/api/days/${DATE}/short`)!.body!
    expect('rating' in body).toBe(false)
  })

  it('names the first value the person rates, in the link and in the dialog', async () => {
    today = { ...today, values: VALUES.map((value) => (value.id === 'v1' ? { ...value, active: false } : value)) }
    await show()
    expect(button('Heute nur kurz: Stimmung und ein Satz')).toBeUndefined()
    await act(async () => button('Heute nur kurz: Schlaf und ein Satz')!.click())
    expect(dialog().textContent).toContain('Für Tage, an denen nicht mehr geht. Schlaf und ein Satz, und der Tag zählt für deine Serie.')
    expect(dialog().querySelector('[role=group]')!.getAttribute('aria-label')).toBe('Schlaf')
  })

  it('is not offered once the day has a page', async () => {
    today = { ...today, day: { date: DATE, text: 'Schon geschrieben.', title: '', tags: [], values: {}, cover: 'illu:baum.abend.herbst', cover_chosen: true } }
    await show()
    expect(button('Heute nur kurz: Stimmung und ein Satz')).toBeUndefined()
    close()
    // Ratings alone are no page yet: the link stays, the rating stands in the dialog already.
    today = { ...today, day: { date: DATE, text: '', title: '', tags: [], values: { v1: 7 }, cover: 'illu:baum.abend.herbst', cover_chosen: false } }
    await show()
    await act(async () => button('Heute nur kurz: Stimmung und ein Satz')!.click())
    expect(button('7 von 10', dialog())!.getAttribute('aria-pressed')).toBe('true')
  })
})
