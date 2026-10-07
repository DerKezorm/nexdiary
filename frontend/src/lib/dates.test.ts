/** Calendar days as the statistics and the page of a day read them: no clock, no time zone, no sliding. */

import { addDays, monthName, weekdayName, weekdayOf, yearBefore } from './dates'

describe('a year before', () => {
  it('keeps the calendar day, also across a leap day', () => {
    expect(yearBefore('2026-10-06')).toBe('2025-10-06')
    expect(yearBefore('2028-03-01')).toBe('2027-03-01')
    expect(yearBefore('2029-02-28')).toBe('2028-02-28')
    expect(yearBefore('2028-12-31')).toBe('2027-12-31')
    // 365 days back would say 2 March for 1 March 2028, one day off.
    expect(addDays('2028-03-01', -365)).toBe('2027-03-02')
  })

  it('meets 29 February with 28 February, as the server does', () => {
    expect(yearBefore('2028-02-29')).toBe('2027-02-28')
    expect(yearBefore('2024-02-29')).toBe('2023-02-28')
  })
})

describe('days', () => {
  it('adds days over month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29')
  })

  it('counts the weekday from Monday and names it in the language', () => {
    expect(weekdayOf('2026-10-05')).toBe(0)
    expect(weekdayOf('2026-10-06')).toBe(1)
    expect(weekdayOf('2026-10-11')).toBe(6)
    expect([0, 2, 6].map((index) => weekdayName(index, 'de'))).toEqual(['Montag', 'Mittwoch', 'Sonntag'])
    expect(weekdayName(1, 'en')).toBe('Tuesday')
  })

  it('names the month, with the year when asked', () => {
    expect(monthName('2026-07-20', 'de')).toBe('Juli')
    expect(monthName('2025-07-20', 'de', true)).toBe('Juli 2025')
    expect(monthName('2026-01-01', 'en')).toBe('January')
  })
})
