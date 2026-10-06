/** Ids for notes are made in the browser, on plain http too, and are UUIDs the server takes. */
import { shouldOpenQuick } from '../components/AppShell'
import { shouldReportZone } from '../state/auth'
import { cleanNote } from '../state/today'
import { newId } from './ids'

describe('a note id', () => {
  it('is a version 4 UUID, a new one every time', () => {
    const ids = Array.from({ length: 50 }, newId)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(new Set(ids).size).toBe(50)
  })

  it('needs no randomUUID, which plain http does not have', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) })
    try {
      expect(newId()).toBe('07070707-0707-4707-8707-070707070707')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the quick note at the start', () => {
  it('opens on a phone at the start page, once per visit, when the person wants it', () => {
    expect(shouldOpenQuick('/', true, 390, false)).toBe(true)
    expect(shouldOpenQuick('/', true, 390, true)).toBe(false)
    expect(shouldOpenQuick('/', false, 390, false)).toBe(false)
    expect(shouldOpenQuick('/', true, 1440, false)).toBe(false)
    expect(shouldOpenQuick('/einstellungen', true, 390, false)).toBe(false)
  })
})

describe('a note before it goes out', () => {
  it('is cleaned as the server cleans it, so the answer can be compared', () => {
    expect(cleanNote('  eins\r\nzwei\u0000\u0007drei  ')).toBe('eins\nzweidrei')
    expect(cleanNote('\t\n')).toBe('')
  })
})

describe('the time zone of the browser', () => {
  it('is reported while the server knows none, and when this browser moved, never over a chosen one', () => {
    expect(shouldReportZone('Europe/Berlin', '', 'browser', null)).toBe(true)
    expect(shouldReportZone('Europe/Berlin', 'Europe/Berlin', 'browser', null)).toBe(false)
    // Another device reported Tokyo; this one was in Berlin before and still is: no switching back.
    expect(shouldReportZone('Europe/Berlin', 'Asia/Tokyo', 'browser', 'Europe/Berlin')).toBe(false)
    // This one travelled.
    expect(shouldReportZone('America/New_York', 'Europe/Berlin', 'browser', 'Europe/Berlin')).toBe(true)
    expect(shouldReportZone('America/New_York', 'Europe/Berlin', 'manual', 'Europe/Berlin')).toBe(false)
    expect(shouldReportZone('', 'Europe/Berlin', 'browser', null)).toBe(false)
  })
})
