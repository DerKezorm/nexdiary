/**
 * Dates as the diary shows them. A day is a `YYYY-MM-DD` the server decided in the person's time zone; it is read as a
 * calendar day, never as a moment, so it never slides to the day before.
 */

function parts(day: string): [number, number, number] {
  const [year, month, date] = day.split('-').map(Number)
  return [year, month, date]
}

/** "Dienstag, 6. Oktober", with the year when asked. */
export function longDate(day: string, language: string, withYear = false): string {
  const [year, month, date] = parts(day)
  return new Intl.DateTimeFormat(language, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, date)))
}

/** "07:12": the hour of a moment in the person's time zone (the browser's while none is known). */
export function timeOf(moment: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timeZone || undefined }).format(new Date(moment))
  } catch {
    return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(moment))
  }
}

/** The browser's own time zone, as the server wants it ("Europe/Berlin"); empty when the browser does not say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

/** "2. Oktober": the day of a moment in the person's time zone, without the year. */
export function dayOfMoment(moment: string, language: string, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' }
  try {
    return new Intl.DateTimeFormat(language, { ...options, timeZone: timeZone || undefined }).format(new Date(moment))
  } catch {
    return new Intl.DateTimeFormat(language, options).format(new Date(moment))
  }
}

/** A calendar day `n` days away, as `YYYY-MM-DD`. */
export function addDays(day: string, n: number): string {
  const moment = new Date(`${day}T12:00:00Z`)
  moment.setUTCDate(moment.getUTCDate() + n)
  return moment.toISOString().slice(0, 10)
}

/** The same calendar day one year earlier; 29 February has no such day then and is met by 28 February. The server
 * reads it the same way (`stats.year_before`). */
export function yearBefore(day: string): string {
  const [year, month, date] = parts(day)
  const back = new Date(Date.UTC(year - 1, month - 1, date, 12))
  // 29 February does not exist a year earlier and rolls over into March: take the last day of February instead.
  if (back.getUTCMonth() !== month - 1) return new Date(Date.UTC(year - 1, month, 0, 12)).toISOString().slice(0, 10)
  return back.toISOString().slice(0, 10)
}

/** 0 for Monday up to 6 for Sunday: the weekday of a calendar day. */
export function weekdayOf(day: string): number {
  const [year, month, date] = parts(day)
  return (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7
}

/** "Oktober" or "Oktober 2025": the month of a calendar day, with the year when asked. */
export function monthName(day: string, language: string, withYear = false): string {
  const [year, month, date] = parts(day)
  return new Intl.DateTimeFormat(language, { month: 'long', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, date)))
}

/** "10. Juli" or "Jul 10": the day and month of a calendar day in the way of the language, as short as it goes (the
 * axes of a chart). */
export function shortDay(day: string, language: string): string {
  const [year, month, date] = parts(day)
  return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, date)))
}

/** "Mo" or "Mon": the short name of a weekday (0 for Monday), in the language. */
export function weekdayShort(index: number, language: string): string {
  return new Intl.DateTimeFormat(language, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index)))
}

/** The name of a weekday (0 for Monday), in the language. */
export function weekdayName(index: number, language: string): string {
  // 1 January 2024 was a Monday.
  return new Intl.DateTimeFormat(language, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index)))
}
