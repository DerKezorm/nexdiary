/**
 * The streak next to the flame: its number in days or weeks, the week so far under a goal below 7, and the shield with
 * its count only while there is one, and its tooltip for the unit of the goal.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { StreakView, TodayData } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { StreakBadges } from './Streak'

const BASE: StreakView = { unit: 'days', goal: 7, current: 4, longest: 9, longest_end: null, today_done: false, shields: 0, week: { count: 2, goal: 7 }, rescues: [] }

function data(series?: Partial<StreakView>, streak = 4): TodayData {
  return { date: '2026-10-07', notes: [], day: null, values: [], streak, photos: [], ...(series ? { series: { ...BASE, ...series } } : {}) }
}

let root: Root
let box: HTMLDivElement

function show(today: TodayData, compact = false): void {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  act(() => root.render(<StreakBadges data={today} compact={compact} />))
}

beforeEach(async () => {
  await changeLanguage('de', false)
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
})

const text = () => box.textContent?.replace(/\s+/g, ' ').trim()
const shield = () => box.querySelector<HTMLElement>('[data-testid="shields"]')

describe('the streak badge', () => {
  it('counts days at goal 7: no week line, no shield while there is none', () => {
    show(data({ current: 4 }))
    expect(text()).toBe('Tage in Folge: 4 Tage')
    expect(box.querySelector('[data-testid="week-standing"]')).toBeNull()
    expect(shield()).toBeNull()
    expect(box.querySelector('[title="Tage in Folge"]')).not.toBeNull()
  })

  it('says one day in the singular', () => {
    show(data({ current: 1 }, 1))
    expect(text()).toBe('Tage in Folge: 1 Tag')
  })

  it('counts weeks below goal 7 and says where the week stands', () => {
    show(data({ unit: 'weeks', goal: 3, current: 6, week: { count: 2, goal: 3 } }))
    expect(text()).toContain('Wochen in Folge: 6 Wochen')
    expect(box.querySelector('[data-testid="week-standing"]')!.textContent).toBe('2 von 3 diese Woche')
    expect(box.querySelector('[title="Wochen in Folge"]')).not.toBeNull()
  })

  it('shows the shields with their number, and the tooltip knows days from weeks', () => {
    show(data({ shields: 2 }))
    expect(shield()!.textContent).toContain('2')
    expect(shield()!.title).toBe('Schützt deine Serie an einem verpassten Tag')
    act(() => root.unmount())
    box.remove()
    show(data({ unit: 'weeks', goal: 1, shields: 1, current: 3, week: { count: 0, goal: 1 } }))
    expect(shield()!.title).toBe('Schützt deine Serie in einer verfehlten Woche')
    expect(box.querySelector('[data-testid="week-standing"]')!.textContent).toBe('0 von 1 diese Woche')
  })

  it('reads a server that sends only the number as days without shields', () => {
    show(data(undefined, 7))
    expect(text()).toBe('Tage in Folge: 7 Tage')
    expect(shield()).toBeNull()
  })

  it('is the same in the small form of the quick note', () => {
    show(data({ unit: 'weeks', goal: 4, current: 2, shields: 1, week: { count: 3, goal: 4 } }), true)
    expect(text()).toContain('2 Wochen')
    expect(shield()).not.toBeNull()
    expect(box.querySelector('[data-testid="week-standing"]')!.textContent).toBe('3 von 4 diese Woche')
  })

  it('speaks English in English', async () => {
    await changeLanguage('en', false)
    show(data({ unit: 'weeks', goal: 3, current: 1, shields: 3, week: { count: 1, goal: 3 } }))
    expect(text()).toContain('Weeks in a row: 1 week')
    expect(box.querySelector('[data-testid="week-standing"]')!.textContent).toBe('1 of 3 this week')
    expect(shield()!.title).toBe('Protects your streak in a week you miss')
  })
})
