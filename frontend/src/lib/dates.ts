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
