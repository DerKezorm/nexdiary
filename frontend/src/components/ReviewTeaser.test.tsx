/**
 * The strip on "Today": last week with seven small covers (the free days dashed) or last month by its name, leading to
 * that week or month; nothing when the server has nothing to look back on; hidden with the X for that period on this
 * device, back for the next one. And it stands where the mock puts it, in each of the three layouts.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import type { Profile } from '../api/client'
import type { ReviewTeaser as Teaser } from '../api/review'
import '../i18n'
import { changeLanguage } from '../i18n'
import { TodayPage } from '../pages/TodayPage'
import { idle } from '../test/wait'
import { ReviewTeaser } from './ReviewTeaser'

const me: { name: string; display_name: string; profile: Profile } = {
  name: 'jule',
  display_name: 'Jule',
  profile: { palette: 'salbei', mode: 'system', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true },
}
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))

const COVER = 'illu:baum.abend.herbst'
const WEEK: Teaser = {
  kind: 'week',
  start: '2026-09-28',
  end: '2026-10-04',
  written: 2,
  total: 7,
  covers: [{ date: '2026-09-28', cover: COVER }, null, { date: '2026-09-30', cover: COVER }, null, null, null, null],
}
const MONTH: Teaser = { kind: 'month', start: '2026-09-01', end: '2026-09-30', written: 12, total: 30, covers: [{ date: '2026-09-15', cover: COVER }] }
const TODAY = { date: '2026-10-06', notes: [], day: null, values: [], streak: 0 }

let teaser: Teaser | null

function serve(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/review/teaser') return json({ teaser })
      if (url.startsWith('/api/today')) return json(TODAY)
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function show(element: React.ReactNode): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => root.render(<MemoryRouter>{element}</MemoryRouter>))
  await idle()
}

/** The browser's storage, as a plain map for each test. */
function storage(): void {
  const kept = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, String(value)),
    removeItem: (key: string) => void kept.delete(key),
  })
}

beforeEach(async () => {
  await changeLanguage('de', false)
  teaser = WEEK
  serve()
  storage()
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

const strip = () => box.querySelector('[data-review-teaser]')

describe('the strip', () => {
  it('shows last week with its seven days and leads to it', async () => {
    await show(<ReviewTeaser />)
    expect(strip()!.textContent).toContain('Rückblick')
    expect(strip()!.textContent).toContain('Deine letzte Woche, 2 von 7 Tagen')
    expect(strip()!.querySelector('a')!.getAttribute('href')).toBe('/rueckblick/woche/2026-09-28')
    expect(strip()!.querySelectorAll('.border-dashed')).toHaveLength(5)
  })

  it('shows last month by its name', async () => {
    teaser = MONTH
    await show(<ReviewTeaser />)
    expect(strip()!.textContent).toContain('Dein September, 12 Tage')
    expect(strip()!.querySelector('a')!.getAttribute('href')).toBe('/rueckblick/monat/2026-09-01')
  })

  it('is not there when there is nothing to look back on', async () => {
    teaser = null
    await show(<ReviewTeaser />)
    expect(strip()).toBeNull()
  })

  it('goes with the X for that week and comes back for the next one', async () => {
    await show(<ReviewTeaser />)
    await act(async () => strip()!.querySelector<HTMLButtonElement>('button[aria-label="Rückblick ausblenden"]')!.click())
    expect(strip()).toBeNull()
    act(() => root.unmount())
    box.remove()
    await show(<ReviewTeaser />)
    expect(strip()).toBeNull()
    act(() => root.unmount())
    box.remove()
    teaser = { ...WEEK, start: '2026-10-05', end: '2026-10-11' }
    await show(<ReviewTeaser />)
    expect(strip()).not.toBeNull()
  })

  it('still shows when the browser keeps nothing', async () => {
    const blocked = () => {
      throw new Error('blocked')
    }
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked })
    await show(<ReviewTeaser />)
    expect(strip()).not.toBeNull()
    await act(async () => strip()!.querySelector<HTMLButtonElement>('button[aria-label="Rückblick ausblenden"]')!.click())
    expect(strip()).toBeNull()
  })
})

describe('on Today', () => {
  it.each(['page', 'columns', 'chat'] as const)('stands where the mock puts it in the layout %s', async (layout) => {
    me.profile = { ...me.profile, layout }
    await show(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />)
    const found = strip()!
    expect(found).not.toBeNull()
    if (layout === 'page') expect(found.previousElementSibling?.tagName).toBe('HEADER')
    if (layout === 'columns') expect(found.parentElement?.tagName).toBe('ASIDE')
    if (layout === 'columns') expect(found.parentElement?.firstElementChild).toBe(found)
    if (layout === 'chat') expect(found.nextElementSibling?.id ?? found.nextElementSibling?.querySelector('#aufschreiben')?.id).toBeTruthy()
  })
})
