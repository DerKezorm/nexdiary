/**
 * The card "Vorlagen" under My account, Writing, against a server stand-in that holds the list whole with its revision:
 * two examples while there is no template (taking one copies it), a dialog to make and change a template (sections with
 * heading and question, added, moved up and down, removed), the default one, deleting with a question first, and a
 * list changed on another device meanwhile (refused, read again, said so).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../../i18n'
import { changeLanguage } from '../../i18n'
import { TemplatesCard } from './TemplatesCard'
import { eventually, idle } from '../../test/wait'

type Section = { heading: string; question: string }
type Stored = { id: string; name: string; sections: Section[] }
type Call = { method: string; url: string; body: { templates: (Partial<Stored> & { sections: Section[] })[]; default: string | null; revision: number } | undefined }

let calls: Call[] = []
let stored: { templates: Stored[]; default: string | null; revision: number }
/** The next save is refused: another device changed the list meanwhile (this is what it holds then). */
let elsewhere: { templates: Stored[]; default: string | null; revision: number } | null = null
let ids = 0

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/templates' && method === 'PUT') {
        if (elsewhere) {
          stored = elsewhere
          elsewhere = null
          return json({ detail: { code: 'templates_changed', message: 'x' } }, 409)
        }
        if (body.revision !== stored.revision) return json({ detail: { code: 'templates_changed', message: 'x' } }, 409)
        stored = {
          templates: body.templates.map((entry: Partial<Stored> & { sections: Section[] }) => ({ id: entry.id ?? `${String(++ids).padStart(12, '0')}`, name: entry.name!, sections: entry.sections })),
          default: body.default,
          revision: stored.revision + 1,
        }
        return json(stored)
      }
      if (url === '/api/templates') return json(stored)
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function show(): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => root.render(<TemplatesCard />))
  await idle()
}

function button(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)
}

function input(label: string, index = 0): HTMLInputElement {
  return [...document.body.querySelectorAll('label')].filter((item) => item.textContent?.startsWith(label)).map((item) => item.querySelector('input')!)[index]
}

function type(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function click(target: HTMLElement | undefined): Promise<void> {
  expect(target, 'the button to click').toBeTruthy()
  await act(async () => target!.click())
  await idle()
}

const saves = () => calls.filter((call) => call.method === 'PUT')
const dialog = () => document.body.querySelector('[role=dialog]')
const names = () => [...box.querySelectorAll('ul > li')].map((item) => item.querySelector('.font-semibold')?.textContent)

function two(): Stored[] {
  return [
    { id: 'aaaaaaaaaaaa', name: 'Tagesrückblick', sections: [{ heading: 'Heute', question: 'Was war heute los?' }, { heading: 'Schönes', question: '' }, { heading: 'Dank', question: 'Wofür?' }] },
    { id: 'bbbbbbbbbbbb', name: 'Arbeitstag', sections: [{ heading: 'Gearbeitet', question: '' }] },
  ]
}

beforeEach(async () => {
  await changeLanguage('de', false)
  stored = { templates: [], default: null, revision: -1 }
  elsewhere = null
  ids = 0
  serve()
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  vi.unstubAllGlobals()
})

describe('the card Vorlagen', () => {
  it('says what it is for, and offers two examples while there is no template', async () => {
    await show()
    expect(box.textContent).toContain('Vorlagen')
    expect(box.textContent).toContain('Beim Ausformulieren füllt die KI nur, wozu deine Notizen etwas sagen, der Rest bleibt leer.')
    expect(box.textContent).toContain('Du hast noch keine Vorlage.')
    expect(box.textContent).toContain('Tagesrückblick')
    expect(box.textContent).toContain('Arbeitstag')
    expect(box.textContent).toContain('Heute, Schönes, Beschäftigt, Dankbar')
    // No choice of a default where there is nothing to choose from.
    expect(box.querySelector('select')).toBeNull()
    expect(saves()).toEqual([])
  })

  it('copies an example when it is taken, and then shows it as a template of its own with the choice of a default', async () => {
    await show()
    await click(button('Tagesrückblick übernehmen'))
    expect(saves()).toHaveLength(1)
    expect(saves()[0].body).toEqual({
      templates: [{
        name: 'Tagesrückblick',
        sections: [
          { heading: 'Heute', question: 'Was war heute los?' },
          { heading: 'Schönes', question: 'Was war schön?' },
          { heading: 'Beschäftigt', question: 'Was hat mich beschäftigt?' },
          { heading: 'Dankbar', question: 'Wofür bin ich dankbar?' },
        ],
      }],
      default: null,
      revision: -1,
    })
    expect(names()).toEqual(['Tagesrückblick'])
    expect(box.textContent).toContain('4 Abschnitte')
    expect(box.textContent).not.toContain('Zum Übernehmen')
    expect(box.querySelector('select')).not.toBeNull()
    // It is a copy: changing it is a change of the copy.
    await click(button('Vorlage bearbeiten: Tagesrückblick'))
    type(input('Name'), 'Mein Rückblick')
    await click(button('Speichern'))
    expect(saves()[1].body!.templates[0].name).toBe('Mein Rückblick')
    expect(saves()[1].body!.revision).toBe(0)
  })

  it('takes the examples in the language of the page', async () => {
    await changeLanguage('en', false)
    await show()
    expect(box.textContent).toContain('You have no template yet.')
    await click(button('Take over Work day'))
    expect(saves()[0].body!.templates[0]).toEqual({
      name: 'Work day',
      sections: [
        { heading: 'Worked on', question: 'What did I work on?' },
        { heading: 'Went well', question: 'What went well?' },
        { heading: 'Got stuck', question: 'What got stuck?' },
        { heading: 'Taking along', question: 'What do I take with me?' },
      ],
    })
    expect(box.textContent).toContain('4 sections')
  })

  it('makes a template in a dialog: a name, sections with heading and question, added and taken away', async () => {
    await show()
    await click(button('Neue Vorlage'))
    expect(dialog()).not.toBeNull()
    // Nothing to save without a name and a heading.
    expect(button('Speichern')!.disabled).toBe(true)
    type(input('Name'), 'Wochenende')
    expect(button('Speichern')!.disabled).toBe(true)
    type(input('Überschrift'), 'Ausflug')
    expect(button('Speichern')!.disabled).toBe(false)
    type(input('Frage als Hinweis'), 'Wohin ging es?')
    await click(button('Abschnitt hinzufügen'))
    type(input('Überschrift', 1), 'Essen')
    await click(button('Abschnitt hinzufügen'))
    type(input('Überschrift', 2), 'Unnötig')
    await click(button('Abschnitt 3 entfernen'))
    await click(button('Speichern'))
    expect(dialog()).toBeNull()
    expect(saves()).toHaveLength(1)
    expect(saves()[0].body).toEqual({
      templates: [{ name: 'Wochenende', sections: [{ heading: 'Ausflug', question: 'Wohin ging es?' }, { heading: 'Essen', question: '' }] }],
      default: null,
      revision: -1,
    })
    expect(names()).toEqual(['Wochenende'])
    expect(box.textContent).toContain('2 Abschnitte')
  })

  it('has at least one section and at most twelve', async () => {
    await show()
    await click(button('Neue Vorlage'))
    expect(button('Abschnitt 1 entfernen')!.disabled).toBe(true)
    for (let at = 1; at < 12; at++) await click(button('Abschnitt hinzufügen'))
    expect(document.body.querySelectorAll('[role=dialog] ol > li')).toHaveLength(12)
    expect(button('Abschnitt hinzufügen')!.disabled).toBe(true)
    await click(button('Abschnitt 12 entfernen'))
    expect(button('Abschnitt hinzufügen')!.disabled).toBe(false)
  })

  it('moves sections up and down with their words, and does not move the first up or the last down', async () => {
    stored = { templates: two(), default: null, revision: 3 }
    await show()
    await click(button('Vorlage bearbeiten: Tagesrückblick'))
    expect(button('Abschnitt 1 nach oben')!.disabled).toBe(true)
    expect(button('Abschnitt 3 nach unten')!.disabled).toBe(true)
    await click(button('Abschnitt 3 nach oben'))
    expect([0, 1, 2].map((index) => input('Überschrift', index).value)).toEqual(['Heute', 'Dank', 'Schönes'])
    // The question went along with its heading.
    expect(input('Frage als Hinweis', 1).value).toBe('Wofür?')
    await click(button('Abschnitt 1 nach unten'))
    expect([0, 1, 2].map((index) => input('Überschrift', index).value)).toEqual(['Dank', 'Heute', 'Schönes'])
    await click(button('Abschnitt 2 entfernen'))
    await click(button('Speichern'))
    expect(saves()[0].body).toEqual({
      templates: [
        { id: 'aaaaaaaaaaaa', name: 'Tagesrückblick', sections: [{ heading: 'Dank', question: 'Wofür?' }, { heading: 'Schönes', question: '' }] },
        { id: 'bbbbbbbbbbbb', name: 'Arbeitstag', sections: [{ heading: 'Gearbeitet', question: '' }] },
      ],
      default: null,
      revision: 3,
    })
  })

  it('saves nothing when the dialog is closed or cancelled', async () => {
    stored = { templates: two(), default: null, revision: 0 }
    await show()
    await click(button('Vorlage bearbeiten: Arbeitstag'))
    type(input('Name'), 'Anders')
    await click(button('Abbrechen'))
    expect(dialog()).toBeNull()
    await click(button('Neue Vorlage'))
    type(input('Name'), 'Neu')
    await click(button('Schließen'))
    expect(saves()).toEqual([])
    expect(names()).toEqual(['Tagesrückblick', 'Arbeitstag'])
  })

  it('chooses the default, and none, in the card', async () => {
    stored = { templates: two(), default: null, revision: 0 }
    await show()
    const select = box.querySelector('select')!
    expect([...select.options].map((option) => option.textContent)).toEqual(['Ohne Vorlage', 'Tagesrückblick', 'Arbeitstag'])
    expect(select.value).toBe('')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, 'bbbbbbbbbbbb')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await idle()
    expect(saves()[0].body).toMatchObject({ default: 'bbbbbbbbbbbb', revision: 0 })
    expect(box.querySelector('select')!.value).toBe('bbbbbbbbbbbb')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(box.querySelector('select')!, '')
      box.querySelector('select')!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await idle()
    expect(saves()[1].body).toMatchObject({ default: null, revision: 1 })
  })

  it('asks before deleting, and a deleted default is no default any more', async () => {
    stored = { templates: two(), default: 'aaaaaaaaaaaa', revision: 0 }
    await show()
    await click(button('Vorlage bearbeiten: Tagesrückblick'))
    await click(button('Löschen'))
    expect(document.body.textContent).toContain('Vorlage löschen?')
    expect(document.body.textContent).toContain('„Tagesrückblick“ wird gelöscht. Seiten, die du damit geschrieben hast, bleiben, wie sie sind.')
    expect(saves()).toEqual([])
    // Changing one's mind costs nothing.
    await click(button('Abbrechen'))
    expect(saves()).toEqual([])
    await click(button('Löschen'))
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].filter((item) => item.textContent?.trim() === 'Löschen').at(-1)
    await click(confirm)
    expect(saves()).toHaveLength(1)
    expect(saves()[0].body).toEqual({ templates: [{ id: 'bbbbbbbbbbbb', name: 'Arbeitstag', sections: [{ heading: 'Gearbeitet', question: '' }] }], default: null, revision: 0 })
    expect(names()).toEqual(['Arbeitstag'])
    expect(dialog()).toBeNull()
  })

  it('reads a list that was changed elsewhere again, says so, and keeps what was typed for another try', async () => {
    stored = { templates: two(), default: null, revision: 0 }
    await show()
    await click(button('Vorlage bearbeiten: Arbeitstag'))
    type(input('Name'), 'Mein Arbeitstag')
    elsewhere = { templates: [...two(), { id: 'cccccccccccc', name: 'Vom anderen Gerät', sections: [{ heading: 'X', question: '' }] }], default: null, revision: 5 }
    await click(button('Speichern'))
    expect(saves()).toHaveLength(1)
    // The dialog stays with its words, the refusal is said in it, and the list behind it is the new one.
    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain('Deine Vorlagen wurden woanders geändert und sind jetzt neu geladen.')
    expect(input('Name').value).toBe('Mein Arbeitstag')
    expect(names()).toEqual(['Tagesrückblick', 'Arbeitstag', 'Vom anderen Gerät'])
    // Trying again lands on the revision just read, with the other device's template kept.
    await click(button('Speichern'))
    expect(saves()).toHaveLength(2)
    expect(saves()[1].body!.revision).toBe(5)
    expect(saves()[1].body!.templates.map((entry) => entry.name)).toEqual(['Tagesrückblick', 'Mein Arbeitstag', 'Vom anderen Gerät'])
    expect(dialog()).toBeNull()
  })

  it('tells a template deleted elsewhere when a change of it is saved', async () => {
    stored = { templates: two(), default: null, revision: 0 }
    await show()
    await click(button('Vorlage bearbeiten: Arbeitstag'))
    type(input('Name'), 'Geändert')
    stored = { templates: [two()[0]], default: null, revision: 1 }
    await click(button('Speichern'))
    // The stand-in refuses by revision first (the server would say the template is gone); either way: read again.
    await eventually(() => expect(names()).toEqual(['Tagesrückblick']), 'the list being read again')
    expect(dialog()!.textContent).toContain('Deine Vorlagen wurden woanders geändert')
  })

  it('has no dashes in its words and no more than the server takes in its fields', async () => {
    await show()
    await click(button('Neue Vorlage'))
    const limits = [...document.body.querySelectorAll('[role=dialog] input')].map((field) => field.getAttribute('maxLength'))
    expect(limits).toEqual(['60', '120', '300'])
    expect(document.body.textContent).not.toMatch(/[–—]/)
  })
})
