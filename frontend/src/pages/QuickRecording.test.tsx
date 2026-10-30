/**
 * A voice recording from the quick note and from "Today": the microphone stands beside the empty field of the quick
 * note only, the recording goes to the attachments of the day, and after midnight the answer to the night question
 * decides which day that is (asked first when nobody answered yet). Today's recordings stand below the notes.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import type { Profile } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { forgetLimits } from '../lib/attachmentUpload'
import { idle, until } from '../test/wait'
import { QuickPage } from './QuickPage'
import { TodayPage } from './TodayPage'

const me: { name: string; display_name: string; profile: Profile } = {
  name: 'jule',
  display_name: 'Jule',
  profile: { palette: 'salbei', mode: 'system', layout: 'page', quick_start: true, journal: 'blog', timezone: 'Europe/Berlin', timezone_source: 'browser', ai: true },
}
vi.mock('../state/auth', () => ({ useAuth: () => ({ me }) }))

class FakeRecorder {
  static isTypeSupported = (type: string) => type === 'audio/webm;codecs=opus'
  state = 'inactive'
  mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? ''
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['sound'], { type: this.mimeType }) })
    this.onstop?.()
  }
}

class FakeXhr {
  static all: FakeXhr[] = []
  upload = { onprogress: null }
  onload: (() => void) | null = null
  onerror = null
  onabort = null
  ontimeout = null
  status = 0
  responseText = ''
  url = ''
  open(_method: string, url: string) {
    this.url = url
  }
  setRequestHeader() {}
  send() {
    FakeXhr.all.push(this)
  }
  abort() {}
}

let calls: { method: string; url: string; body: Record<string, unknown> | undefined }[] = []
let today: Record<string, unknown> = {}
let limits: Record<string, unknown> = { video_max_mb: 500, other_max_mb: 100, ffmpeg: true }

function base(date: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { date, notes: [], day: null, values: [], streak: 2, photos: [], attachments: [], night: { active: false }, catch_up: { count: 0, days: [] }, ...extra }
}
const night = (choice: 'yesterday' | 'today' | null) => ({ active: true, today: '2026-10-07', yesterday: '2026-10-06', choice })

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/today') return json(today)
      if (url === '/api/attachments/limits') return json(limits)
      if (url === '/api/night' && method === 'PUT') {
        const choice = body!.choice as 'yesterday' | 'today'
        today = base(choice === 'yesterday' ? '2026-10-06' : '2026-10-07', { night: night(choice) })
        return json(night(choice))
      }
      return json([])
    }),
  )
}

let root: Root
let box: HTMLDivElement

async function show(page: 'quick' | 'today'): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  box.id = 'root'
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => root.render(<MemoryRouter>{page === 'quick' ? <QuickPage /> : <TodayPage now={new Date(2026, 9, 7, 0, 30)} />}</MemoryRouter>))
  await idle()
}

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent?.trim() === label)
async function press(label: string): Promise<void> {
  const found = await until(() => button(label), label)
  await act(async () => found.click())
}

async function record(): Promise<void> {
  await press('Sprachaufnahme')
  await press('Aufnahme starten')
  await press('Aufnahme beenden')
  await until(() => document.querySelector('[data-recorder="done"]'), 'the stop')
  await press('Behalten')
}

beforeEach(async () => {
  Element.prototype.scrollTo ??= () => undefined
  await changeLanguage('de', false)
  forgetLimits()
  limits = { video_max_mb: 500, other_max_mb: 100, ffmpeg: true }
  FakeXhr.all = []
  serve()
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [] }) }, configurable: true })
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
})

it('puts a recording of the night onto the day the night question chose, asked first', async () => {
  today = base('2026-10-07', { night: night(null) })
  await show('quick')
  await record()
  // Nobody answered for this night yet: the question comes before anything goes out.
  await until(() => document.body.textContent?.includes('Zu welchem Tag gehört das?'), 'the night question')
  expect(FakeXhr.all).toHaveLength(0)
  await press('Zu gestern (Dienstag)')
  const sent = await until(() => FakeXhr.all[0], 'the upload')
  expect(calls.some((call) => call.url === '/api/night' && call.body?.choice === 'yesterday')).toBe(true)
  expect(new URL(sent.url, 'http://x').searchParams.get('date')).toBe('2026-10-06')
  expect(new URL(sent.url, 'http://x').searchParams.get('kind')).toBe('audio')
  sent.status = 201
  sent.responseText = JSON.stringify({ id: 'a'.repeat(32), date: '2026-10-06', kind: 'audio', name: 'Sprachaufnahme 00:30', size: 9, seconds: 4, width: null, height: null, codec: 'opus', status: 'ready', progress: null, playable: true, can_convert: false, has_preview: false, created_at: '' })
  await act(async () => sent.onload?.())
  // Below the notes, the recordings of the day now shown (yesterday, as answered).
  const list = await until(() => box.querySelector('[data-recordings]'), 'the recordings')
  expect(list.textContent).toContain('Sprachaufnahme 00:30')
})

it('shows the microphone of the quick note only while the field is empty, and not without ffmpeg', async () => {
  today = base('2026-10-07')
  await show('quick')
  expect(button('Sprachaufnahme')).toBeDefined()
  const field = box.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'kurz notiert')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(button('Sprachaufnahme')).toBeUndefined()
  act(() => root.unmount())
  forgetLimits()
  limits = { video_max_mb: 500, other_max_mb: 100, ffmpeg: false }
  await show('quick')
  expect(button('Sprachaufnahme')).toBeUndefined()
})

it('records on "Today" too, and the recording joins the attachments of the day', async () => {
  today = base('2026-10-07')
  await show('today')
  await record()
  const sent = await until(() => FakeXhr.all[0], 'the upload')
  expect(new URL(sent.url, 'http://x').searchParams.get('date')).toBe('2026-10-07')
  sent.status = 201
  sent.responseText = JSON.stringify({ id: 'b'.repeat(32), date: '2026-10-07', kind: 'audio', name: 'Am Morgen', size: 9, seconds: 4, width: null, height: null, codec: 'opus', status: 'ready', progress: null, playable: true, can_convert: false, has_preview: false, created_at: '' })
  await act(async () => sent.onload?.())
  await until(() => box.querySelector(`[data-attachments] [data-attachment="${'b'.repeat(32)}"]`), 'the recording among the attachments')
})
