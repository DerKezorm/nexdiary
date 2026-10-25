/**
 * "Tag nachtragen" in the journal: yesterday preselected in the person's zone, nothing after today, a day without a
 * page goes to the writing view, a day with one to reading it.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'

import '../i18n'
import { changeLanguage } from '../i18n'
import { idle, until } from '../test/wait'
import { AddDayButton } from './AddDay'

const me = { profile: { timezone: 'America/Los_Angeles' } }
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))

/** The days that have a page. */
let written: string[] = []
let asked: string[] = []

function serve(): void {
  asked = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url)
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      const date = url.slice('/api/days/'.length)
      if (written.includes(date)) return json({ date, title: 'Seite', text: 'Text' })
      return json({ detail: { code: 'not_found', message: 'Not found.' } }, 404)
    }),
  )
}

function Landed({ what }: { what: string }) {
  const { date } = useParams()
  return <p data-landed>{`${what} ${date}`}</p>
}

let root: Root
let box: HTMLDivElement

async function show(): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/tagebuch']}>
        <Routes>
          <Route path="/tagebuch" element={<AddDayButton />} />
          <Route path="/tag/:date" element={<Landed what="read" />} />
          <Route path="/tag/:date/schreiben" element={<Landed what="write" />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await idle()
  await act(async () => box.querySelector<HTMLButtonElement>('[data-add-day]')!.click())
  await idle()
}

const field = () => box.querySelector<HTMLInputElement>('input[type="date"]')!
const submit = () => box.querySelector<HTMLButtonElement>('button[type="submit"]')!

async function choose(value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(field(), value)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function go(): Promise<string> {
  await act(async () => submit().click())
  return (await until(() => box.querySelector('[data-landed]'), 'the next page')).textContent ?? ''
}

beforeAll(async () => {
  await changeLanguage('de')
})

beforeEach(() => {
  written = []
  // 22:30 on 7 October in Los Angeles, already 8 October in UTC and in Europe: the person's day counts.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-08T05:30:00Z'))
  serve()
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('adding a past day', () => {
  it('offers yesterday in the person zone and nothing after today', async () => {
    await show()
    expect(box.textContent).toContain('Tag nachtragen')
    expect(field().value).toBe('2026-10-06')
    expect(field().max).toBe('2026-10-07')
  })

  it('opens a day without a page in the writing view', async () => {
    await show()
    await choose('2026-09-12')
    expect(await go()).toBe('write 2026-09-12')
    expect(asked).toEqual(['/api/days/2026-09-12'])
  })

  it('opens a day that has a page to read it', async () => {
    written = ['2026-10-06']
    await show()
    expect(await go()).toBe('read 2026-10-06')
  })

  it('does not go to a day still to come', async () => {
    await show()
    await choose('2026-10-08')
    expect(submit().disabled).toBe(true)
    await act(async () => submit().click())
    await idle()
    expect(asked).toEqual([])
    expect(box.querySelector('[data-landed]')).toBeNull()
  })
})
