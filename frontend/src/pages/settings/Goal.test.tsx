/**
 * The writing goal: a slider from 1 to 7 that is kept when it is let go (not at every step of a drag), what it means
 * said below it in days or weeks, the hint that the streak is counted again, and a refused change put back.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { Me } from '../../api/client'
import '../../i18n'
import { changeLanguage } from '../../i18n'
import { idle } from '../../test/wait'
import { GoalCard } from './PersonalCards'

const setMe = vi.fn()
const me = {
  id: 1, name: 'jule', display_name: 'Jule', role: 'member', language: 'de',
  profile: { palette: 'salbei', mode: 'light', layout: 'page', quick_start: true, journal: 'blog', timezone: 'UTC', timezone_source: 'browser', ai: true, goal: 7 },
} as unknown as Me
let current = me
// Like the real thing: what is put in with setMe is what the next render reads.
vi.mock('../../state/auth', async () => {
  const { useState } = await import('react')
  return {
    useAuth: () => {
      const [kept, keep] = useState(current)
      return {
        me: kept,
        setMe: (next: Me) => {
          setMe(next)
          keep(next)
        },
      }
    },
  }
})

type Call = { method: string; url: string; body: Record<string, unknown> | undefined }
let calls: Call[] = []
let refuse = false

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/me/preferences') return refuse ? json({ detail: { code: 'bad_preference', message: 'x' } }, 422) : json({ ...current.profile, ...body })
      if (url === '/api/auth/me') return json(me)
      return json({})
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
  await act(async () => root.render(<GoalCard />))
  await idle()
}

beforeEach(async () => {
  await changeLanguage('de', false)
  current = me
  refuse = false
  setMe.mockClear()
  serve()
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

const slider = () => box.querySelector<HTMLInputElement>('input[type="range"]')!
const said = () => box.querySelector('[data-testid="goal-said"]')!.textContent
const saves = () => calls.filter((call) => call.url === '/api/me/preferences').map((call) => call.body)

/** Moves the slider the way a person does: the value changes on the way, and the save comes when it is let go. */
async function drag(to: number, release: 'pointerup' | 'none' = 'pointerup'): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(slider(), String(to))
    slider().dispatchEvent(new Event('input', { bubbles: true }))
    slider().dispatchEvent(new Event('change', { bubbles: true }))
  })
  if (release === 'pointerup') await act(async () => slider().dispatchEvent(new Event('pointerup', { bubbles: true })))
  await idle()
}

describe('the writing goal', () => {
  it('starts at 7, every day, and says days in a row', async () => {
    await show()
    expect(slider().value).toBe('7')
    expect([slider().min, slider().max, slider().step]).toEqual(['1', '7', '1'])
    expect(said()).toBe('7 Mal pro Woche, also jeden Tag')
    expect(box.textContent).toContain('Deine Serie zählt Tage in Folge.')
    expect(box.textContent).toContain('Ein langer Eintrag ab 300 Wörtern bringt zusätzlich ein Schild, höchstens eines pro Woche.')
    expect(box.textContent).toContain('Deine Serie wird mit dem neuen Ziel neu gezählt.')
    expect(saves()).toEqual([])
  })

  it('keeps the goal when the slider is let go, once, and then counts weeks', async () => {
    await show()
    await drag(3)
    expect(saves()).toEqual([{ goal: 3 }])
    expect(said()).toBe('3 Mal pro Woche')
    expect(box.textContent).toContain('Deine Serie zählt Wochen in Folge')
    expect(box.textContent).toContain('An welchen Tagen du schreibst, ist egal.')
    expect(box.textContent).toContain('für je 4 erreichte Wochen in Folge')
    // Letting go again without a change saves nothing more.
    await act(async () => slider().dispatchEvent(new Event('pointerup', { bubbles: true })))
    expect(saves()).toHaveLength(1)
  })

  it('does not save at every step of the drag, and the keyboard saves on release too', async () => {
    await show()
    await drag(5, 'none')
    await drag(4, 'none')
    expect(saves()).toEqual([])
    expect(said()).toBe('4 Mal pro Woche')
    await act(async () => slider().dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true })))
    await idle()
    expect(saves()).toEqual([{ goal: 4 }])
  })

  it('puts the old goal back when the server refuses', async () => {
    await show()
    refuse = true
    await drag(2)
    expect(saves()).toEqual([{ goal: 2 }])
    expect(box.querySelector('[role="alert"]')).not.toBeNull()
    expect(calls.some((call) => call.url === '/api/auth/me')).toBe(true)
  })

  it('shows the goal that is kept and speaks English in English', async () => {
    await changeLanguage('en', false)
    current = { ...me, profile: { ...me.profile, goal: 1 } } as unknown as Me
    await show()
    expect(slider().value).toBe('1')
    expect(said()).toBe('1 time a week')
    expect(box.textContent).toContain('Your streak counts weeks in a row in which you reached your goal, whichever days you write on.')
    await drag(7)
    expect(said()).toBe('7 times a week, so every day')
    expect(box.textContent).toContain('Your streak counts days in a row.')
  })
})
