/**
 * The question before photos are deleted: it names where a photo is still used (cover, text, note) and says it goes
 * everywhere; a photo of a locked day cannot go; several at once; the answer "no" deletes nothing; what the server
 * refuses is said.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { PhotoDeletion } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { eventually, idle, until } from '../test/wait'
import { PhotoDeleteProvider, useDeletePhotos } from './PhotoDelete'

type Call = { method: string; url: string; body: unknown }
let calls: Call[] = []
let uses: Record<string, unknown> = {}
let outcome: PhotoDeletion | null = null
let refuse: string | null = null
let root: Root
let box: HTMLDivElement
let answer: Promise<PhotoDeletion | null> | null = null

const ONE = '1'.repeat(32)
const TWO = '2'.repeat(32)

function Asker({ ids, known }: { ids: string[]; known?: Record<string, { cover: boolean; text: boolean; notes: { id: string; date: string }[]; date?: string; locked?: boolean }> }) {
  const { confirmDelete } = useDeletePhotos()
  return (
    <button type="button" data-ask onClick={() => (answer = confirmDelete(ids, known))}>
      Fragen
    </button>
  )
}

async function show(ids: string[], known?: Parameters<typeof Asker>[0]['known']): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <PhotoDeleteProvider>
        <Asker ids={ids} known={known} />
      </PhotoDeleteProvider>,
    ),
  )
  await act(async () => box.querySelector<HTMLButtonElement>('[data-ask]')!.click())
}

const question = () => document.querySelector<HTMLElement>('[role=dialog]')
const button = (label: string) => [...(question()?.querySelectorAll('button') ?? [])].find((item) => item.textContent === label)
/** The button once the question knows where the photo is used (it cannot be pressed before). */
const ready = (label: string) => {
  const found = button(label)
  return found && !found.disabled ? found : null
}

beforeEach(async () => {
  await changeLanguage('de', false)
  calls = []
  uses = {}
  outcome = null
  refuse = null
  answer = null
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/photos/delete') return refuse ? json({ detail: { code: refuse, message: 'x' } }, 409) : json(outcome ?? { deleted: body.ids, locked: [], missing: [] })
      const match = /^\/api\/photos\/(\w+)\/uses$/.exec(url)
      if (match) return json(uses[match[1]] ?? { cover: false, text: false, notes: [], date: '2026-10-04', locked: false })
      return json({})
    }),
  )
})

afterEach(async () => {
  await act(async () => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

describe('the question before deleting a photo', () => {
  it('says plainly that an unused photo goes with its files, and deletes only on the answer', async () => {
    await show([ONE])
    await until(() => ready('Foto löschen'), 'the question')
    expect(question()!.textContent).toContain('Original und Vorschau')
    expect(question()!.textContent).not.toContain('noch verwendet')
    expect(calls.some((call) => call.url === '/api/photos/delete')).toBe(false)
    await act(async () => button('Foto löschen')!.click())
    const result = await answer
    expect(calls.find((call) => call.url === '/api/photos/delete')!.body).toEqual({ ids: [ONE] })
    expect(result).toEqual({ deleted: [ONE], locked: [], missing: [] })
    await until(() => question() === null, 'the question closing')
  })

  it('names where the photo is used and says it is removed everywhere', async () => {
    uses[ONE] = { cover: true, text: true, notes: [{ id: 'n1', date: '2026-10-04' }, { id: 'n2', date: '2026-10-05' }], date: '2026-10-04', locked: false }
    await show([ONE])
    await until(() => question()?.querySelector('[data-testid="photo-uses"]'), 'the places')
    const lines = [...question()!.querySelectorAll('[data-testid="photo-uses"] li')].map((item) => item.textContent)
    expect(lines).toEqual(['Titelbild vom Sonntag, 4. Oktober 2026', 'Bild im Text vom Sonntag, 4. Oktober 2026', 'An einer Notiz vom Sonntag, 4. Oktober 2026', 'An einer Notiz vom Montag, 5. Oktober 2026'])
    expect(question()!.textContent).toContain('Es wird überall entfernt')
  })

  it('leaves everything alone when the answer is no, and when it is closed', async () => {
    await show([ONE])
    await until(() => button('Abbrechen'), 'the question')
    await act(async () => button('Abbrechen')!.click())
    expect(await answer).toBeNull()
    expect(calls.some((call) => call.url === '/api/photos/delete')).toBe(false)
    await until(() => question() === null, 'the question closing')
  })

  it('does not offer to delete a photo of a locked day', async () => {
    uses[ONE] = { cover: false, text: false, notes: [], date: '2026-10-04', locked: true }
    await show([ONE])
    await until(() => question()?.textContent?.includes('für immer verschlossen'), 'the hint')
    expect((button('Foto löschen') as HTMLButtonElement).disabled).toBe(true)
  })

  it('asks once for several, counts what is used and what stays, and tells afterwards what stayed', async () => {
    outcome = { deleted: [ONE], locked: [TWO], missing: [] }
    await show([ONE, TWO], {
      [ONE]: { cover: true, text: false, notes: [] },
      [TWO]: { cover: false, text: false, notes: [], locked: true },
    })
    await until(() => ready('2 Fotos löschen'), 'the question')
    expect(question()!.textContent).toContain('2 Fotos werden')
    expect(question()!.textContent).toContain('Eines davon wird noch verwendet')
    expect(question()!.textContent).toContain('Eines gehört zu einem verschlossenen Tag und bleibt.')
    // The uses were known: the server was not asked for each one.
    expect(calls.some((call) => call.url.endsWith('/uses'))).toBe(false)
    await act(async () => button('2 Fotos löschen')!.click())
    await until(() => question()?.textContent?.includes('Eines ist geblieben'), 'the outcome')
    await act(async () => button('Fertig')!.click())
    expect(await answer).toEqual(outcome)
  })

  it('says what the server refuses and stays open', async () => {
    refuse = 'day_locked'
    await show([ONE])
    await until(() => ready('Foto löschen'), 'the question')
    await act(async () => button('Foto löschen')!.click())
    await eventually(() => expect(question()!.textContent).toContain('Dieser Tag ist für immer verschlossen und lässt sich nicht mehr ändern.'), 'the refusal')
    await idle()
    expect(question()).not.toBeNull()
  })
})
