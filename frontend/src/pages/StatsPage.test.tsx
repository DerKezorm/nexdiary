/**
 * The statistics: what the server worked out is drawn as it comes (nothing is recomputed here), the value is named as
 * the person named it, every panel has its empty state, titles stay text, and the charts answer a tap.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import type { Stats } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { StatsPage } from './StatsPage'
import { idle } from '../test/wait'

const MOOD = { id: 'v1', name: 'Laune', low: 'mies', high: 'super' }
const SLEEP = { id: 'v2', name: 'Schlaf', low: 'kaum', high: 'erholt' }
const COVER = 'illu:baum.abend.herbst'

function line(last: (number | null)[]): (number | null)[] {
  return [...Array<null>(180 - last.length).fill(null), ...last]
}

function stats(change: Partial<Stats> = {}): Stats {
  return {
    today: '2026-10-06',
    pages: 6,
    unreadable: 0,
    value: MOOD,
    values: [MOOD, SLEEP],
    tiles: { current: 2, longest: 12, longest_end: '2026-07-20', today_done: false, year: 2026, days_year: 140, days_total: 171, words: 12345, words_per_day: 72 },
    calendar: {
      start: '2026-04-13',
      weeks: 26,
      days: [
        { date: '2026-10-06', written: true, value: 9, title: 'Heute <img src=x onerror="window.__xss=1">' },
        { date: '2026-10-05', written: true, value: 4, title: 'Zu viel auf einmal' },
        { date: '2026-10-04', written: false, value: 2, title: 'Nur ein Wert' },
        { date: '2026-04-13', written: true, value: null, title: '' },
      ],
    },
    series: {
      days: 180,
      end: '2026-10-06',
      values: {
        v1: { values: line([null, 6, 8]), means: line([null, 6, 7]), mean: { '30': 7, '90': 7, '180': 7.25 } },
        v2: { values: line([5, null]), means: line([5, 5]), mean: { '30': 5, '90': 5, '180': null } },
      },
    },
    weekdays: { days: [4, 6, 8, 5, 5, 7, 6].map((mean) => ({ n: 3, mean })), best: 2 },
    together: [
      { kind: 'value', name: 'Schlaf', a_n: 20, b_n: 12, a_mean: 7.5, b_mean: 5.25, diff: 2.25, similar: false },
      { kind: 'weekend', a_n: 9, b_n: 30, a_mean: 6.1, b_mean: 6.2, diff: -0.1, similar: true },
      { kind: 'tag', tag: 'sport', a_n: 6, b_n: 40, a_mean: 5, b_mean: 6.4, diff: -1.4, similar: false },
    ],
    tags: [{ tag: 'familie', count: 40 }, { tag: 'sport', count: 10 }],
    extremes: {
      '30': { count: 2, best: { date: '2026-10-05', title: 'Der Gute', excerpt: 'Ein guter Tag', cover: COVER, value: 9 }, worst: { date: '2026-10-04', title: 'Der Schlimme', excerpt: 'Ein schlimmer Tag', cover: COVER, value: 2 } },
      '365': { count: 1, best: null, worst: null },
      all: { count: 5, best: { date: '2026-03-01', title: 'Frühling', excerpt: '', cover: COVER, value: 10 }, worst: { date: '2026-02-01', title: '', excerpt: 'Ohne Titel', cover: COVER, value: 1 } },
    },
    writing: { total: 8, ai: 3, self: 5, photos: 2, shared: 1 },
    year_ago: { date: '2025-10-06', title: 'Der erste Schultag', excerpt: 'Mia war aufgeregt', cover: COVER },
    ...change,
  }
}

type Reply = { status: number; body: unknown }
let reply: Reply
let asked = 0

function serve(): void {
  asked = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/stats') {
        asked += 1
        return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
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
  await act(async () =>
    root.render(
      <MemoryRouter>
        <StatsPage />
      </MemoryRouter>,
    ),
  )
  await idle()
}

async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to click')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await idle()
}

const button = (label: string, inside: ParentNode = box) => [...inside.querySelectorAll('button')].find((candidate) => candidate.textContent === label)
const panel = (title: string) => [...box.querySelectorAll('section')].find((section) => section.querySelector('h2')?.textContent === title)

beforeEach(async () => {
  await changeLanguage('de', false)
  reply = { status: 200, body: stats() }
  serve()
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
  delete (window as { __xss?: number }).__xss
})

describe('the figures at the top', () => {
  it('draws the four tiles from the server, in German', async () => {
    await show()
    const tiles = [...box.querySelectorAll('.card')].slice(0, 4).map((tile) => tile.textContent?.trim())
    expect(tiles[0]).toBe('Serie2 Tageheute noch offen')
    expect(tiles[1]).toBe('Längste Serie12 Tageim Juli')
    expect(tiles[2]).toBe('Tage 2026140171 insgesamt')
    expect(tiles[3]).toBe('Wörter12.345etwa 72 je Tag')
    expect(box.querySelector('h1')!.textContent).toBe('Statistik')
    expect(box.textContent).toContain('Nur aus deinen eigenen Tagen. Niemand sonst sieht diese Seite.')
  })

  it('says one day and still going, and a longest streak from another year with the year', async () => {
    reply.body = stats({ tiles: { ...stats().tiles, current: 1, longest: 1, today_done: true } })
    await show()
    let tiles = [...box.querySelectorAll('.card')].slice(0, 2).map((tile) => tile.textContent?.trim())
    expect(tiles).toEqual(['Serie1 Tagheute schon geschrieben', 'Längste Serie1 Tagläuft noch'])
    act(() => root.unmount())
    box.remove()
    reply.body = stats({ tiles: { ...stats().tiles, longest_end: '2025-07-20' } })
    await show()
    tiles = [...box.querySelectorAll('.card')].slice(1, 2).map((tile) => tile.textContent?.trim())
    expect(tiles).toEqual(['Längste Serie12 Tageim Juli 2025'])
  })

  it('in English: the same figures, the English words', async () => {
    await changeLanguage('en', false)
    await show()
    expect(box.querySelector('h1')!.textContent).toBe('Statistics')
    const tiles = [...box.querySelectorAll('.card')].slice(0, 4).map((tile) => tile.textContent?.trim())
    expect(tiles).toEqual(['Streak2 daystoday is still open', 'Longest streak12 daysin July', 'Days 2026140171 in total', 'Words12,345about 72 a day'])
    expect(panel('Your weekdays')).toBeDefined()
    expect(panel('What goes together')!.textContent).toContain('Together does not mean because.')
  })
})

describe('the value is named as the person named it', () => {
  it('speaks of Laune, never of a fixed "Stimmung"', async () => {
    await show()
    expect(box.textContent).not.toContain('Stimmung')
    expect(panel('Laune im Verlauf')).toBeDefined()
    expect(panel('Dein halbes Jahr')!.textContent).toContain('Je dunkler, desto höher liegt Laune.')
    expect(panel('Deine Wochentage')!.textContent).toContain('Laune im Schnitt, je Wochentag.')
    expect(panel('Deine Wochentage')!.textContent).toContain('Am höchsten liegt Laune am Mittwoch.')
    expect(panel('Was zusammenhängt')!.textContent).toContain('Laune an solchen Tagen, verglichen mit den anderen.')
    expect(panel('Mein bester und mein schlimmster Tag')!.textContent).toContain('Nach Laune.')
    expect([...panel('Dein halbes Jahr')!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Laune', 'Geschrieben'])
  })

  it('draws the chart of the value picked, with its own mean', async () => {
    await show()
    expect(panel('Laune im Verlauf')!.textContent).toContain('Im Schnitt 7,0 von 10.')
    const select = box.querySelector('select') as HTMLSelectElement
    expect([...select.options].map((option) => option.textContent)).toEqual(['Laune', 'Schlaf'])
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(select, 'v2')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(panel('Schlaf im Verlauf')).toBeDefined()
    // Schlaf has no mean over 180 days: the text says so instead of "von 10".
    await click(button('180', panel('Schlaf im Verlauf')!))
    expect(panel('Schlaf im Verlauf')!.textContent).toContain('In diesem Zeitraum gibt es noch keinen Wert.')
    expect(box.textContent).not.toContain('NaN')
  })

  it('has panels that ask for a value when none is asked, and the calendar then shows what was written', async () => {
    reply.body = stats({ value: null, values: [], series: { days: 180, end: '2026-10-06', values: {} }, weekdays: { days: Array.from({ length: 7 }, () => ({ n: 0, mean: null })), best: null }, together: [], extremes: { '30': { count: 0, best: null, worst: null }, '365': { count: 0, best: null, worst: null }, all: { count: 0, best: null, worst: null } } })
    await show()
    expect(box.textContent).toContain('Im Moment fragt nexdiary nach keinem Wert.')
    expect(panel('Dein halbes Jahr')!.textContent).toContain('Ein Kästchen je Tag, an dem du geschrieben hast.')
    expect([...panel('Dein halbes Jahr')!.querySelectorAll('button')]).toHaveLength(0)
    expect(box.textContent).not.toContain('NaN')
  })
})

describe('the year as a calendar', () => {
  it('draws a square for each day up to today and tells a day on a tap, its title as text', async () => {
    await show()
    const squares = [...panel('Dein halbes Jahr')!.querySelectorAll('rect')]
    // 26 weeks from Monday 13 April, Tuesday 6 October is the second day of the last week: 25 * 7 + 2.
    expect(squares).toHaveLength(25 * 7 + 2)
    const today = squares.find((square) => square.getAttribute('data-date') === '2026-10-06')!
    expect(today.getAttribute('stroke')).toBe('var(--ink)')
    await click(today)
    expect(panel('Dein halbes Jahr')!.textContent).toContain('Dienstag, 6. Oktober')
    expect(panel('Dein halbes Jahr')!.textContent).toContain('Laune 9')
    expect(box.querySelectorAll('img[src="x"]')).toHaveLength(0)
    expect((window as { __xss?: number }).__xss).toBeUndefined()
    // A day without a page says so.
    await click(squares.find((square) => square.getAttribute('data-date') === '2026-10-03'))
    expect(panel('Dein halbes Jahr')!.textContent).toContain('nichts geschrieben')
    // A second tap on the same square takes the tip away.
    await click(squares.find((square) => square.getAttribute('data-date') === '2026-10-03'))
    expect(panel('Dein halbes Jahr')!.textContent).not.toContain('nichts geschrieben')
  })

  it('shades by the value, and by "written" in the other mode', async () => {
    await show()
    const shade = (date: string) => {
      const square = [...panel('Dein halbes Jahr')!.querySelectorAll('rect')].find((candidate) => candidate.getAttribute('data-date') === date)!
      return [square.getAttribute('fill'), square.getAttribute('fill-opacity')]
    }
    expect(shade('2026-10-06')).toEqual(['var(--accent)', '1']) // 9 of 10
    expect(shade('2026-10-05')).toEqual(['var(--accent)', '0.45']) // 4
    expect(shade('2026-10-04')).toEqual(['var(--accent)', '0.25']) // 2, though nothing is written
    expect(shade('2026-04-13')).toEqual(['var(--accent)', '0.25']) // written without a rating
    expect(shade('2026-10-03')).toEqual(['var(--sheet-2)', '1']) // no page
    await click(button('Geschrieben', panel('Dein halbes Jahr')!))
    expect(shade('2026-10-04')).toEqual(['var(--sheet-2)', '1'])
    expect(shade('2026-10-05')).toEqual(['var(--accent)', '1'])
    expect(panel('Dein halbes Jahr')!.textContent).toContain('geschrieben')
  })
})

describe('one value over time', () => {
  it('answers a tap with the day, the value and the mean of the week', async () => {
    await show()
    const svg = panel('Laune im Verlauf')!.querySelector('svg')!
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 720, height: 220, right: 720, bottom: 220, x: 0, y: 0, toJSON: () => ({}) })
    await act(async () => {
      svg.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 720 }))
    })
    const tip = panel('Laune im Verlauf')!.querySelector('[role="status"]')!
    expect(tip.textContent).toBe('Dienstag, 6. OktoberLaune 8 · Schnitt 7,0')
    await act(async () => {
      svg.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 26 + (686 * 88) / 89 }))
    })
    expect(panel('Laune im Verlauf')!.querySelector('[role="status"]')!.textContent).toBe('Montag, 5. OktoberLaune 6 · Schnitt 6,0')
    await act(async () => {
      svg.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 26 + (686 * 87) / 89 }))
    })
    expect(panel('Laune im Verlauf')!.querySelector('[role="status"]')!.textContent).toContain('kein Wert · Schnitt –')
  })

  it('breaks the line where the mean has no week behind it and draws a dot for each rating', async () => {
    await show()
    const svg = panel('Laune im Verlauf')!.querySelector('svg')!
    expect(svg.querySelectorAll('circle')).toHaveLength(2)
    const path = svg.querySelector('path')!.getAttribute('d')!
    expect(path.match(/M/g)).toHaveLength(1)
    expect(path.match(/L/g)).toHaveLength(1)
    await click(button('30 Tage', panel('Laune im Verlauf')!))
    expect(panel('Laune im Verlauf')!.querySelector('svg')!.getAttribute('aria-label')).toBe('Laune der letzten 30 Tage')
    expect(panel('Laune im Verlauf')!.textContent).toContain('Im Schnitt 7,0 von 10.')
  })
})

describe('the line and the finger', () => {
  it('starts a new stretch of the line after a week without a mean', async () => {
    const base = stats()
    reply.body = { ...base, series: { ...base.series, values: { ...base.series.values, v1: { values: line([6, null, 7]), means: line([6, null, 7]), mean: { '30': 6.5, '90': 6.5, '180': 6.5 } } } } }
    await show()
    const path = panel('Laune im Verlauf')!.querySelector('svg path')!.getAttribute('d')!
    expect(path.match(/M/g)).toHaveLength(2)
    expect(path.match(/L/g)).toBeNull()
  })

  it('keeps the tip after a finger lifts and takes it away when a mouse leaves', async () => {
    await show()
    const svg = panel('Laune im Verlauf')!.querySelector('svg')!
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 720, height: 220, right: 720, bottom: 220, x: 0, y: 0, toJSON: () => ({}) })
    const leave = async (pointerType: string) =>
      act(async () => {
        const event = new MouseEvent('pointerout', { bubbles: true, relatedTarget: null })
        Object.defineProperty(event, 'pointerType', { value: pointerType })
        svg.dispatchEvent(event)
      })
    await act(async () => {
      svg.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 700 }))
    })
    expect(panel('Laune im Verlauf')!.querySelector('[role="status"]')).not.toBeNull()
    await leave('touch')
    expect(panel('Laune im Verlauf')!.querySelector('[role="status"]')).not.toBeNull()
    await leave('mouse')
    expect(panel('Laune im Verlauf')!.querySelector('[role="status"]')).toBeNull()
  })
})

describe('the best and the worst day', () => {
  it('shows both for the span asked, the younger tie being the server\'s business', async () => {
    await show()
    // Over a year the server has only one rated day: the friendly sentence.
    expect(panel('Mein bester und mein schlimmster Tag')!.textContent).toContain('Dafür braucht es ein paar Tage mit Laune.')
    await click(button('30 Tage', panel('Mein bester und mein schlimmster Tag')!))
    const cards = [...panel('Mein bester und mein schlimmster Tag')!.querySelectorAll('a')]
    expect(cards.map((card) => card.getAttribute('href'))).toEqual(['/tag/2026-10-05', '/tag/2026-10-04'])
    expect(cards[0].textContent).toContain('Bester Tag')
    expect(cards[0].textContent).toContain('Laune 9/10')
    expect(cards[0].textContent).toContain('Der Gute')
    expect(cards[1].textContent).toContain('Schlimmster Tag')
    await click(button('Immer', panel('Mein bester und mein schlimmster Tag')!))
    const every = [...panel('Mein bester und mein schlimmster Tag')!.querySelectorAll('a')]
    expect(every[0].textContent).toContain('Frühling')
    // A day without a title is called so, and has its text.
    expect(every[1].textContent).toContain('Ohne Titel')
    expect(every[1].textContent).toContain('Laune 1/10')
  })
})

describe('dates and weekdays on the axes follow the language', () => {
  const svgTexts = () => [...box.querySelectorAll('svg text')].map((text) => text.textContent ?? '')
  /** The labels along the time axis of the value chart: a day and a month, not the plain numbers of the scale. */
  const axisDates = () => svgTexts().filter((text) => /\d/.test(text) && !/^\d+$/.test(text))

  it('in German: day, dot, month; Mo, Mi, Fr by the calendar and Mo to So under the bars', async () => {
    await show()
    const dates = axisDates()
    expect(dates.length).toBeGreaterThan(1)
    for (const text of dates) expect(text).toMatch(/^\d{1,2}\. \p{L}+\.?$/u)
    expect(svgTexts()).toEqual(expect.arrayContaining(['Mo', 'Mi', 'Fr']))
    expect([...panel('Deine Wochentage')!.querySelectorAll('.flex.h-44 > div')].map((bar) => bar.lastElementChild!.textContent)).toEqual(['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'])
  })

  it('in English: month, then day, never the German order; Mon, Wed, Fri by the calendar and Mon to Sun under the bars', async () => {
    await changeLanguage('en', false)
    await show()
    const dates = axisDates()
    expect(dates.length).toBeGreaterThan(1)
    for (const text of dates) expect(text).toMatch(/^[A-Z][a-z]{2,4}\.? \d{1,2}$/)
    expect(dates.some((text) => text.includes('.') && /\d\./.test(text))).toBe(false)
    const texts = svgTexts()
    expect(texts).toEqual(expect.arrayContaining(['Mon', 'Wed', 'Fri']))
    expect(texts).not.toContain('Mo')
    expect(texts).not.toContain('We')
    expect([...panel('Your weekdays')!.querySelectorAll('.flex.h-44 > div')].map((bar) => bar.lastElementChild!.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  })
})

describe('the weekdays and what goes together', () => {
  it('draws seven bars and names the best weekday; too few days say so', async () => {
    await show()
    const bars = panel('Deine Wochentage')!.querySelectorAll('.flex.h-44 > div')
    expect(bars).toHaveLength(7)
    expect(bars[2].textContent).toBe('8,0Mi')
    expect(bars[6].textContent).toBe('6,0So')
    act(() => root.unmount())
    box.remove()
    reply.body = stats({ weekdays: { days: [{ n: 1, mean: 7 }, ...Array.from({ length: 6 }, () => ({ n: 0, mean: null }))], best: null } })
    await show()
    expect(panel('Deine Wochentage')!.textContent).toContain('braucht es an mindestens zwei Wochentagen je drei Tage mit Wert.')
    expect(panel('Deine Wochentage')!.textContent).not.toContain('Am höchsten')
  })

  it('writes the differences in signs, calls a small one hardly any, and always says together is not because', async () => {
    await show()
    const rows = [...panel('Was zusammenhängt')!.querySelectorAll('li')].map((row) => row.querySelector('[aria-hidden]')!.textContent)
    expect(rows).toEqual(['Schlaf mindestens 7+2,3', 'Wochenendekaum Unterschied', 'Tage mit #sport−1,4'])
    expect(panel('Was zusammenhängt')!.textContent).toContain('diese 7,5')
    expect(panel('Was zusammenhängt')!.textContent).toContain('Schlaf unter 7 5,3')
    expect(panel('Was zusammenhängt')!.textContent).toContain('Zusammen heißt nicht wegen. Es zeigt nur, was bei dir oft gemeinsam auftritt.')
    // The same as a sentence for a screen reader.
    expect(panel('Was zusammenhängt')!.querySelector('.sr-only')!.textContent).toBe('Schlaf mindestens 7: im Schnitt 7,5 an 20 Tagen. Schlaf unter 7: im Schnitt 5,3 an 12 Tagen.')
  })

  it('has a friendly empty state when no comparison has enough days', async () => {
    reply.body = stats({ together: [] })
    await show()
    expect(panel('Was zusammenhängt')!.textContent).toContain('mindestens 5 auf jeder Seite eines Vergleichs.')
    expect(panel('Was zusammenhängt')!.textContent).toContain('Zusammen heißt nicht wegen.')
  })
})

describe('tags, writing and a year ago', () => {
  it('draws the tags with their bars, the split with percentages of the written days, and a year ago', async () => {
    await show()
    expect([...panel('Häufigste Tags')!.querySelectorAll('li')].map((row) => row.textContent)).toEqual(['#familie40', '#sport10'])
    const split = [...panel('Schreiben')!.querySelectorAll('li')].map((row) => row.textContent)
    expect(split).toEqual(['Mit KI ausformuliert3' + '38 %', 'Selbst geschrieben5' + '63 %', 'Mit Fotos2' + '25 %', 'Mit der Familie geteilt1' + '13 %'])
    const ago = box.querySelector('a[href="/tag/2025-10-06"]')!
    expect(ago.textContent).toBe('Heute vor einem JahrDer erste SchultagMia war aufgeregt')
  })

  it('shows no year-ago card when there is no such day, and nothing divides by nothing', async () => {
    reply.body = stats({ year_ago: null, tags: [], writing: { total: 0, ai: 0, self: 0, photos: 0, shared: 0 } })
    await show()
    expect(box.querySelector('a[href="/tag/2025-10-06"]')).toBeNull()
    expect(panel('Häufigste Tags')!.textContent).toContain('Noch keine Tags.')
    expect([...panel('Schreiben')!.querySelectorAll('li')].map((row) => row.textContent)).toEqual(['Mit KI ausformuliert00 %', 'Selbst geschrieben00 %', 'Mit Fotos00 %', 'Mit der Familie geteilt00 %'])
    expect(box.textContent).not.toContain('NaN')
  })
})

describe('the page around', () => {
  it('asks the server once and shows an empty diary kindly, with the four tiles at zero', async () => {
    reply.body = stats({ pages: 0, tiles: { current: 0, longest: 0, longest_end: null, today_done: false, year: 2026, days_year: 0, days_total: 0, words: 0, words_per_day: 0 }, year_ago: null })
    await show()
    expect(asked).toBe(1)
    expect(box.textContent).toContain('Noch keine Seite geschrieben.')
    expect(box.querySelectorAll('section')).toHaveLength(0)
    expect([...box.querySelectorAll('.card')].slice(0, 2).map((tile) => tile.textContent?.trim())).toEqual(['Serie0 Tageheute noch offen', 'Längste Serie0 Tage'])
    expect(box.textContent).not.toContain('NaN')
  })

  it('says how many days could not be read', async () => {
    reply.body = stats({ unreadable: 2 })
    await show()
    expect(box.textContent).toContain('2 Tage ließen sich nicht lesen und fehlen hier.')
  })

  it('says what went wrong in words when the server refuses', async () => {
    reply = { status: 429, body: { detail: { code: 'stats_too_often', message: 'x' } } }
    await show()
    expect(box.textContent).toContain('Zu oft in die Statistik geschaut. Warte eine Minute.')
    expect(box.querySelectorAll('section')).toHaveLength(0)
  })
})
