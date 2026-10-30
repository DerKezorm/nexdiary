/**
 * Settings, Attachments: the real values of the server, the storage per person through the setting that exists, the
 * switch for converting, the queue in words, saving only what is in range, and the server without ffmpeg.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { AttachmentSettings } from '../../api/client'
import '../../i18n'
import { changeLanguage } from '../../i18n'
import { idle } from '../../test/wait'
import { AttachmentsCard } from './AttachmentsCard'

let settings: AttachmentSettings
let calls: { method: string; url: string; body: unknown }[] = []
let root: Root
let box: HTMLDivElement

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/admin/attachments' && method === 'PUT') {
        settings = { ...settings, ...body }
        return json(settings)
      }
      if (url === '/api/admin/attachments') return json(settings)
      if (url === '/api/settings' && method === 'PUT') return json({ storage_per_person_gb: body.storage_per_person_gb })
      if (url === '/api/settings') return json({ storage_per_person_gb: 5 })
      return json({})
    }),
  )
}

async function show(): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => root.render(<AttachmentsCard />))
  await idle()
}

const fields = () => [...box.querySelectorAll<HTMLInputElement>('input[type="number"]')]
async function type(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function save(): Promise<void> {
  await act(async () => box.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await idle()
}

beforeEach(async () => {
  await changeLanguage('de', false)
  settings = { video_max_mb: 500, other_max_mb: 100, convert: true, ffmpeg: true, queue: { waiting: 0, running: null, last: { seconds_video: 84, seconds_took: 230 } } }
  serve()
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
  vi.unstubAllGlobals()
})

it('shows the values of the server and the queue in words', async () => {
  await show()
  expect(box.querySelector('h2')!.textContent).toBe('Anhänge und Speicher')
  expect(fields().map((field) => field.value)).toEqual(['500', '100', '5'])
  expect(box.textContent).toContain('in GB, mit Fotos')
  expect(box.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
  expect(box.querySelector('[data-queue]')!.textContent).toBe('Warteschlange: leer. Zuletzt umgewandelt: ein Video mit 1:24 in 3 Minuten 50.')
  expect(box.querySelector('[data-no-ffmpeg]')).toBeNull()
})

it('says how the queue stands while a video converts and others wait', async () => {
  settings.queue = { waiting: 2, running: { id: 'a'.repeat(32), progress: 37 }, last: null }
  await show()
  expect(box.querySelector('[data-queue]')!.textContent).toBe('Warteschlange: ein Video wird umgewandelt (37 %). 2 Videos warten.')
})

it('saves the limits and the switch, and the storage per person through the server setting', async () => {
  await show()
  await type(fields()[0], '800')
  await type(fields()[2], '20')
  await act(async () => (box.querySelector('[role="switch"]') as HTMLElement).click())
  await save()
  expect(calls.filter((call) => call.method === 'PUT').map((call) => [call.url, call.body])).toEqual([
    ['/api/admin/attachments', { video_max_mb: 800, other_max_mb: 100, convert: false }],
    ['/api/settings', { storage_per_person_gb: 20 }],
  ])
  expect(box.textContent).toContain('Gespeichert.')
})

it('sends nothing out of range', async () => {
  await show()
  await type(fields()[0], '5000')
  await save()
  expect(calls.some((call) => call.method === 'PUT')).toBe(false)
  expect(box.querySelector('[role="alert"]')!.textContent).toContain('Video 1 bis 4000 MB')
  await type(fields()[0], '500')
  await type(fields()[1], '0')
  await save()
  expect(calls.some((call) => call.method === 'PUT')).toBe(false)
})

it('says when the server has no ffmpeg, and offers no converting then', async () => {
  settings = { ...settings, ffmpeg: false, convert: false }
  await show()
  expect(box.querySelector('[data-no-ffmpeg]')!.textContent).toContain('Auf diesem Server fehlt ffmpeg. Videos und Sprachaufnahmen gehen deshalb nicht, PDFs und Links schon.')
  expect(box.querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true)
})
