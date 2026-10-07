/** The share dialog with many people: a field to find one, the chosen stay chosen while it filters. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../i18n'
import { changeLanguage } from '../i18n'
import { ShareDialog } from './ShareDialog'
import { eventually, idle } from '../test/wait'

const NAMES = ['anna', 'ben', 'carla', 'dirk', 'emma', 'fritz', 'gabi', 'hanna', 'ida']
let count = NAMES.length
const sent: unknown[] = []

let root: Root
let box: HTMLDivElement

beforeAll(async () => {
  await changeLanguage('de')
})

beforeEach(() => {
  sent.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/people') return new Response(JSON.stringify(NAMES.slice(0, count).map((name, index) => ({ id: index + 2, name, display_name: '', avatar: null }))), { headers: { 'Content-Type': 'application/json' } })
      sent.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ date: '2026-10-04', people: [], with_values: false, with_notes: false }), { headers: { 'Content-Type': 'application/json' } })
    }),
  )
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

async function show(): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => {
    root.render(<ShareDialog date="2026-10-04" shares={{ date: '2026-10-04', people: [], with_values: false, with_notes: false }} onClose={() => undefined} onShared={() => undefined} />)
  })
  await idle()
}

const people = () => [...box.querySelectorAll('button[aria-pressed]')].map((button) => button.textContent)

it('offers a field to find a person when there are many, and keeps the chosen ones', async () => {
  count = NAMES.length
  await show()
  const field = box.querySelector<HTMLInputElement>('input[aria-label="Person suchen"]')!
  expect(field).not.toBeNull()
  await act(async () => (box.querySelector('button[aria-pressed]') as HTMLElement).click())
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'HAN')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(people()).toEqual(['Hhanna'])
  await act(async () => (box.querySelector('button[aria-pressed]') as HTMLElement).click())
  await act(async () => ([...box.querySelectorAll('button')].find((button) => button.textContent === 'Teilen') as HTMLElement).click())
  await eventually(() => expect(sent).toEqual([{ to: [2, 9], with_values: false, with_notes: false }]), 'the share being sent')
})

it('has no such field for a few people', async () => {
  count = 3
  await show()
  expect(box.querySelector('input[aria-label="Person suchen"]')).toBeNull()
  expect(people()).toHaveLength(3)
})
