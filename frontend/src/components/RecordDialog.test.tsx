/**
 * The dialog of a voice recording: start, the time running, stop, the name ready ("Sprachaufnahme HH:MM"), "Behalten"
 * uploads it as audio to the day; it stops by itself after 30 minutes and says so; without https or without the
 * microphone allowed it says what to do instead of failing.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { Attachment } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { forgetLimits } from '../lib/attachmentUpload'
import { idle, until } from '../test/wait'
import { RecordDialog } from './AttachMenu'

vi.mock('../state/auth', () => ({ useAuth: () => ({ me: { profile: { timezone: 'UTC' } } }) }))

class FakeRecorder {
  static isTypeSupported(type: string) {
    return type === 'audio/webm;codecs=opus'
  }
  state: 'inactive' | 'recording' = 'inactive'
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

let root: Root
let box: HTMLDivElement
let now = Date.UTC(2026, 9, 30, 19, 7, 0)
let added: Attachment[] = []
let closed = 0
let microphone: () => Promise<MediaStream>

function allow(): void {
  microphone = async () => ({ getTracks: () => [{ stop: () => undefined }] }) as unknown as MediaStream
}

beforeEach(async () => {
  await changeLanguage('de', false)
  forgetLimits()
  now = Date.UTC(2026, 9, 30, 19, 7, 0)
  added = []
  closed = 0
  allow()
  FakeXhr.all = []
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })))
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => microphone() }, configurable: true })
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
})

async function show(): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () =>
    root.render(
      <RecordDialog
        date="2026-10-30"
        now={() => now}
        onAdded={(attachment) => added.push(attachment)}
        onClose={() => {
          closed += 1
        }}
      />,
    ),
  )
  await idle()
}

const state = () => document.querySelector('[data-recorder]')?.getAttribute('data-recorder')
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.getAttribute('aria-label') === label || element.textContent?.trim() === label)

it('records, stops by itself after 30 minutes, and keeps the recording under its name', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  await show()
  expect(document.body.textContent).toContain('Beim ersten Mal fragt der Browser, ob nexdiary das Mikrofon nutzen darf. Höchstens 30 Minuten.')
  await act(async () => button('Aufnahme starten')!.click())
  await until(() => state() === 'on', 'the recording')
  now += 12 * 60 * 1000 + 5000
  await act(async () => vi.advanceTimersByTime(150))
  expect(document.querySelector('[data-record-time]')!.textContent).toBe('12:05')
  expect(state()).toBe('on')
  now += 18 * 60 * 1000
  await act(async () => vi.advanceTimersByTime(150))
  await until(() => state() === 'done', 'the stop')
  expect(document.querySelector('[data-record-limit]')!.textContent).toBe('Nach 30 Minuten hat die Aufnahme von selbst aufgehört.')
  expect(document.querySelector('[data-record-time]')!.textContent).toBe('30:00')
  const name = document.querySelector<HTMLInputElement>('[data-recorder] input')!
  expect(name.value).toBe('Sprachaufnahme 19:07')
  await act(async () => button('Behalten')!.click())
  const sent = await until(() => FakeXhr.all[0], 'the upload')
  const query = new URL(sent.url, 'http://x').searchParams
  expect(query.get('kind')).toBe('audio')
  expect(query.get('name')).toBe('Sprachaufnahme 19:07')
  expect(query.get('date')).toBe('2026-10-30')
  sent.status = 201
  sent.responseText = JSON.stringify({ id: 'a'.repeat(32), kind: 'audio', name: 'Sprachaufnahme 19:07', date: '2026-10-30' })
  await act(async () => sent.onload?.())
  expect(added.map((item) => item.id)).toEqual(['a'.repeat(32)])
  expect(closed).toBe(1)
})

it('throws a recording away on "Verwerfen" and begins anew', async () => {
  await show()
  await act(async () => button('Aufnahme starten')!.click())
  await until(() => state() === 'on', 'the recording')
  await act(async () => button('Aufnahme beenden')!.click())
  await until(() => state() === 'done', 'the stop')
  await act(async () => button('Verwerfen')!.click())
  expect(state()).toBe('ready')
  expect(FakeXhr.all).toHaveLength(0)
  expect(added).toEqual([])
})

it('says what to do without https, instead of a button that fails', async () => {
  Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
  await show()
  expect(document.querySelector('[data-record-blocked]')!.getAttribute('data-record-blocked')).toBe('insecure')
  expect(document.body.textContent).toContain('Aufnehmen geht nur, wenn nexdiary über https läuft.')
  expect(button('Aufnahme starten')).toBeUndefined()
})

it('says what to do when the microphone is not allowed, or there is none', async () => {
  microphone = async () => Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }))
  await show()
  await act(async () => button('Aufnahme starten')!.click())
  await until(() => document.querySelector('[data-record-blocked]'), 'the hint')
  expect(document.querySelector('[data-record-blocked]')!.textContent).toContain('nexdiary darf das Mikrofon nicht nutzen.')
  act(() => root.unmount())
  microphone = async () => Promise.reject(Object.assign(new Error('no'), { name: 'NotFoundError' }))
  await show()
  await act(async () => button('Aufnahme starten')!.click())
  await until(() => document.querySelector('[data-record-blocked]'), 'the hint')
  expect(document.querySelector('[data-record-blocked]')!.textContent).toContain('Kein Mikrofon gefunden.')
})

it('says it when the browser cannot record at all', async () => {
  vi.stubGlobal('MediaRecorder', undefined)
  await show()
  expect(document.querySelector('[data-record-blocked]')!.getAttribute('data-record-blocked')).toBe('unsupported')
})

it('frees the microphone when the dialog is closed while the browser still asks', async () => {
  const stop = vi.fn()
  let grant: (value: MediaStream) => void = () => undefined
  microphone = () =>
    new Promise<MediaStream>((resolve) => {
      grant = resolve
    })
  await show()
  await act(async () => button('Aufnahme starten')!.click())
  expect(state()).toBe('starting')
  act(() => root.unmount())
  await act(async () => grant({ getTracks: () => [{ stop }] } as unknown as MediaStream))
  expect(stop).toHaveBeenCalledTimes(1)
})
