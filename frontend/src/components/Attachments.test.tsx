/**
 * The attachments of a day: the section with every kind, the menu "Anhängen" (without ffmpeg no video and no
 * recording), uploading with its progress, a refusal and a second try with the same id, the size said before a byte
 * goes out, the HEVC question (yes, no, not asked when the server does not offer it), asking about a conversion only
 * while one runs and never after the page is left, the link check, deleting (asked first), a shared day read only, and
 * the PDF reader leafing through pages.
 */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { Attachment } from '../api/client'
import '../i18n'
import { changeLanguage } from '../i18n'
import { forgetLimits, timing } from '../lib/attachmentUpload'
import { forgetThumbs, thumbCount } from '../lib/pdfThumbs'
import { eventually, idle, until } from '../test/wait'
import { Attachments, type AttachmentSource } from './Attachments'

vi.mock('../state/auth', () => ({ useAuth: () => ({ me: { profile: { timezone: 'Europe/Berlin' } } }) }))
vi.mock('../lib/pdf', () => ({
  openPdf: () => ({ doc: Promise.resolve({ numPages: 3 }), close: () => undefined }),
  drawPage: async () => undefined,
}))

const DATE = '2026-10-04'
const hex = (n: number) => String(n).repeat(32).slice(0, 32)

function item(n: number, kind: Attachment['kind'], over: Partial<Attachment> = {}): Attachment {
  return { id: hex(n), date: DATE, kind, name: `Anhang ${n}`, size: 5 * 1024 * 1024, seconds: kind === 'video' || kind === 'audio' ? 84 : null, width: null, height: null, codec: null, status: 'ready', progress: null, playable: true, can_convert: false, has_preview: false, created_at: '', ...over }
}

// --- A stand-in server --------------------------------------------------------------------------------------------------

type Call = { method: string; url: string; body: unknown }
let calls: Call[] = []
let limits: unknown = { video_max_mb: 500, other_max_mb: 100, ffmpeg: true }
/** What `GET /api/attachments?date=` answers, one after the other (the last one stays). */
let lists: Attachment[][] = []
/** While set, `GET /api/attachments?date=` fails with this status. */
let listFails = 0
let convertAnswer: Attachment | null = null
let linkAnswer: { status: number; body: unknown } | null = null

function serve(): void {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, url, body })
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
      const address = new URL(url, 'http://x')
      if (address.pathname === '/api/attachments/limits') return json(limits)
      if (address.pathname === '/api/attachments' && method === 'GET' && listFails) return json({ detail: { code: 'internal_error', message: 'x' } }, listFails)
      if (address.pathname === '/api/attachments' && method === 'GET') return json({ attachments: lists.length > 1 ? lists.shift() : (lists[0] ?? []) })
      if (address.pathname === '/api/attachments/link') return linkAnswer ? json(linkAnswer.body, linkAnswer.status) : json(item(9, 'link', { name: body.title ?? 'example.com', url: body.url }), 201)
      if (/^\/api\/attachments\/\w+\/convert$/.test(address.pathname)) return json(convertAnswer, 202)
      if (/^\/api\/attachments\/\w+$/.test(address.pathname) && method === 'DELETE') return new Response(null, { status: 204 })
      return json({})
    }),
  )
}

// --- A stand-in for XMLHttpRequest: the test answers each upload by hand --------------------------------------------------

class FakeXhr {
  static all: FakeXhr[] = []
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout: (() => void) | null = null
  status = 0
  responseText = ''
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown = null
  aborted = false
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }
  send(body: unknown) {
    this.body = body
    FakeXhr.all.push(this)
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }
  get query(): URLSearchParams {
    return new URL(this.url, 'http://x').searchParams
  }
  async progress(loaded: number, total: number) {
    await act(async () => this.upload.onprogress?.({ lengthComputable: true, loaded, total }))
  }
  async answer(status: number, body: unknown) {
    this.status = status
    this.responseText = JSON.stringify(body)
    await act(async () => this.onload?.())
  }
  async drop() {
    await act(async () => this.onerror?.())
  }
}

// --- The page ------------------------------------------------------------------------------------------------------------

let root: Root
let box: HTMLDivElement

function Host({ start, ...rest }: { start: Attachment[]; editable?: boolean; source?: AttachmentSource; pollMs?: number; onPhotos?: (files: File[]) => void }) {
  const [items, setItems] = useState(start)
  return <Attachments date={DATE} items={items} onChange={(change) => setItems(change)} {...rest} />
}

async function show(start: Attachment[], props: { editable?: boolean; source?: AttachmentSource; pollMs?: number; onPhotos?: (files: File[]) => void } = { editable: true }): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  box.id = 'root'
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => root.render(<Host start={start} {...props} />))
  await idle()
}

const all = <T extends Element = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)]
function button(text: string): HTMLButtonElement | undefined {
  return all<HTMLButtonElement>('button').find((element) => element.textContent?.trim() === text || element.getAttribute('aria-label') === text)
}
async function click(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to click')
  await act(async () => (element as HTMLElement).click())
}
async function choose(selector: string, files: File[]): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(selector)!
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
}
async function type(field: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const file = (name: string, bytes: number, kind = 'video/mp4') => new File([new Uint8Array(bytes)], name, { type: kind })

beforeEach(async () => {
  await changeLanguage('de', false)
  forgetLimits()
  limits = { video_max_mb: 500, other_max_mb: 100, ffmpeg: true }
  lists = []
  listFails = 0
  forgetThumbs()
  convertAnswer = null
  linkAnswer = null
  FakeXhr.all = []
  serve()
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the section', () => {
  it('shows videos and PDFs as tiles, recordings and links as rows, with length, HEVC mark and host', async () => {
    await show([
      item(1, 'video', { name: 'Mia am Steg', seconds: 48, has_preview: true }),
      item(2, 'audio', { name: 'Mia erfindet ein Lied', seconds: 72 }),
      item(3, 'link', { name: 'Strandbad', url: 'https://strandbad.example.com/oktober' }),
      item(4, 'video', { name: 'Pilz im Moos', seconds: 21, codec: 'hevc', playable: false }),
      item(5, 'pdf', { name: 'Omas Kürbissuppe.pdf' }),
    ])
    const section = box.querySelector('[data-attachments]')!
    expect(section.querySelector('h2')!.textContent).toBe('Anhänge5')
    expect(all('.grid [data-attachment]').map((tile) => tile.getAttribute('data-kind'))).toEqual(['video', 'video', 'pdf'])
    expect(all('ul [data-attachment]').map((row) => row.getAttribute('data-kind'))).toEqual(['audio', 'link'])
    const video = box.querySelector(`[data-attachment="${hex(1)}"]`)!
    expect(video.textContent).toContain('0:48')
    expect(video.querySelector('img')!.getAttribute('src')).toBe(`/api/attachments/${hex(1)}/preview`)
    expect(video.querySelector('[data-hevc]')).toBeNull()
    expect(box.querySelector(`[data-attachment="${hex(4)}"] [data-hevc]`)!.textContent).toBe('HEVC')
    const link = box.querySelector<HTMLAnchorElement>(`[data-attachment="${hex(3)}"] a`)!
    expect(link.getAttribute('href')).toBe('https://strandbad.example.com/oktober')
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noopener noreferrer')
    expect(link.textContent).toContain('strandbad.example.com')
    const audio = box.querySelector(`[data-attachment="${hex(2)}"]`)!
    expect(audio.querySelector('audio')!.getAttribute('src')).toBe(`/api/attachments/${hex(2)}`)
    expect(audio.textContent).toContain('1:12')
    // The same recording draws the same waveform every time.
    const heights = () => all<HTMLElement>(`[data-attachment="${hex(2)}"] [role="slider"] span`).map((bar) => bar.style.height)
    const first = heights()
    expect(first).toHaveLength(48)
    act(() => root.unmount())
    await show([item(2, 'audio')])
    expect(heights()).toEqual(first)
  })

  it('invites to add on an own day without any, and shows nothing on a day only read', async () => {
    await show([])
    expect(box.textContent).toContain('Videos, Sprachaufnahmen, PDFs oder Links zu diesem Tag.')
    expect(button('Anhängen')).toBeDefined()
    act(() => root.unmount())
    await show([], { editable: false })
    expect(box.querySelector('[data-attachments]')).toBeNull()
  })

  it('opens a link only when it is one: another scheme stands as text', async () => {
    await show([item(3, 'link', { url: 'javascript:alert(1)' })])
    expect(box.querySelector(`[data-attachment="${hex(3)}"] a`)!.hasAttribute('href')).toBe(false)
  })
})

describe('the menu', () => {
  it('offers photos (when the page takes them), video, recording, PDF and link', async () => {
    await show([], { editable: true, onPhotos: () => undefined })
    await click(button('Anhängen'))
    expect(all('[role="menuitem"]').map((entry) => entry.textContent?.trim())).toEqual(['Fotos dazulegen', 'Video', 'Sprachaufnahme', 'PDF', 'Link'])
    expect(document.activeElement?.textContent?.trim()).toBe('Fotos dazulegen')
    expect(document.querySelector<HTMLInputElement>('[data-video-input]')!.accept).toBe('video/*')
    expect(document.querySelector<HTMLInputElement>('[data-pdf-input]')!.accept).toContain('application/pdf')
    expect(document.querySelector<HTMLInputElement>('[data-photos-input]')!.multiple).toBe(true)
    // Escape closes it again.
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('[data-attach-menu]')).toBeNull()
  })

  it('leaves out video and recording when the server has no ffmpeg', async () => {
    limits = { video_max_mb: 500, other_max_mb: 100, ffmpeg: false }
    await show([])
    await click(button('Anhängen'))
    expect(all('[role="menuitem"]').map((entry) => entry.textContent?.trim())).toEqual(['PDF', 'Link'])
  })

  it('hands the chosen photos to the page, all at once', async () => {
    const taken: File[][] = []
    await show([], { editable: true, onPhotos: (files) => taken.push(files) })
    await choose('[data-photos-input]', [file('a.jpg', 10, 'image/jpeg'), file('b.jpg', 10, 'image/jpeg')])
    expect(taken.map((files) => files.map((one) => one.name))).toEqual([['a.jpg', 'b.jpg']])
  })
})

describe('uploading', () => {
  it('sends the file with its kind, name, day and an id, shows the progress, and adds what the server keeps', async () => {
    await show([])
    await choose('[data-video-input]', [file('kastanien.mp4', 2048)])
    const sent = await until(() => FakeXhr.all[0], 'the upload')
    expect(sent.method).toBe('POST')
    expect(new URL(sent.url, 'http://x').pathname).toBe('/api/attachments')
    expect(sent.query.get('kind')).toBe('video')
    expect(sent.query.get('name')).toBe('kastanien')
    expect(sent.query.get('date')).toBe(DATE)
    expect(sent.query.get('upload_id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(sent.headers['X-Nexdiary-Client']).toMatch(/^tab-/)
    await sent.progress(512, 2048)
    expect(document.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('25')
    expect(document.querySelector('[data-upload]')!.textContent).toContain('Ort und Gerät nimmt nexdiary dabei heraus.')
    await sent.answer(201, item(7, 'video', { name: 'kastanien', codec: 'h264' }))
    await eventually(() => expect(document.querySelector('[data-upload]')).toBeNull())
    expect(box.querySelector(`[data-attachment="${hex(7)}"]`)).not.toBeNull()
    // Not HEVC: no question.
    expect(document.querySelector('[data-hevc-question]')).toBeNull()
  })

  it('tries again with the same id after the network dropped, and once more by hand', async () => {
    await show([])
    await choose('[data-pdf-input]', [file('Elternbrief.pdf', 100, 'application/pdf')])
    const first = await until(() => FakeXhr.all[0], 'the upload')
    await first.drop()
    const second = await until(() => FakeXhr.all[1], 'the second try', )
    expect(second.query.get('upload_id')).toBe(first.query.get('upload_id'))
    expect(second.query.get('name')).toBe('Elternbrief.pdf')
    await second.drop()
    const third = await until(() => FakeXhr.all[2], 'the third try')
    await third.drop()
    // After three tries it says so, and a press on the button sends it again, still as the same upload.
    const problem = await until(() => document.querySelector('[data-upload-problem]'), 'the problem')
    expect(problem.getAttribute('data-upload-problem')).toBe('network')
    expect(problem.textContent).toBe('Der Server ist nicht erreichbar.')
    await click(button('Nochmal versuchen'))
    const fourth = await until(() => FakeXhr.all[3], 'the try by hand')
    expect(fourth.query.get('upload_id')).toBe(first.query.get('upload_id'))
    await fourth.answer(200, item(8, 'pdf', { name: 'Elternbrief.pdf' }))
    await eventually(() => expect(box.querySelector(`[data-attachment="${hex(8)}"]`)).not.toBeNull())
  })

  it('tries a stalled upload again by itself, then says so and offers to send it once more', async () => {
    vi.spyOn(timing, 'wait').mockResolvedValue(undefined)
    await show([])
    await choose('[data-video-input]', [file('lang.mp4', 64)])
    for (let round = 0; round < 3; round++) await (await until(() => FakeXhr.all[round], `try ${round + 1}`)).answer(408, { detail: { code: 'upload_stalled', message: 'x' } })
    const problem = await until(() => document.querySelector('[data-upload-problem]'), 'the problem')
    expect(problem.textContent).toBe('Die Verbindung hat zu lange gestockt. Versuch es noch einmal.')
    expect(new Set(FakeXhr.all.map((xhr) => xhr.query.get('upload_id'))).size).toBe(1)
    await click(button('Nochmal versuchen'))
    const again = await until(() => FakeXhr.all[3], 'the try by hand')
    expect(again.query.get('upload_id')).toBe(FakeXhr.all[0].query.get('upload_id'))
    vi.restoreAllMocks()
  })

  it('says each refusal of the server in words and does not try a refusal again', async () => {
    const cases: [number, Record<string, unknown>, string][] = [
      [422, { code: 'attachment_not_supported' }, 'Dieses Format nimmt nexdiary nicht an, oder die Datei lässt sich nicht lesen.'],
      [422, { code: 'attachment_wrong_kind' }, 'Die Datei passt nicht zu dem, was du gewählt hast.'],
      [409, { code: 'day_locked' }, 'Dieser Tag ist für immer verschlossen'],
      [409, { code: 'storage_full', max_gb: 5 }, 'Dein Speicher ist voll (höchstens 5 GB).'],
      [422, { code: 'attachments_per_day' }, 'An einem Tag gehen höchstens 50 Anhänge.'],
      [413, { code: 'attachment_too_large', max_mb: 250 }, 'Die Datei ist zu groß, höchstens 250 MB.'],
    ]
    for (const [status, detail, words] of cases) {
      FakeXhr.all = []
      await show([])
      await choose('[data-video-input]', [file('x.mov', 10)])
      const sent = await until(() => FakeXhr.all[0], 'the upload')
      await sent.answer(status, { detail: { ...detail, message: 'x' } })
      const problem = await until(() => document.querySelector('[data-upload-problem]'), String(detail.code))
      expect(problem.textContent).toContain(words)
      expect(FakeXhr.all).toHaveLength(1)
      expect(button('Nochmal versuchen')).toBeUndefined()
      act(() => root.unmount())
      box.remove()
      document.body.innerHTML = ''
    }
    // The limit named by the refusal is kept: the next larger video is stopped before a byte goes out.
    FakeXhr.all = []
    await show([])
    await choose('[data-video-input]', [file('gross.mov', 251 * 1024 * 1024)])
    const problem = await until(() => document.querySelector('[data-upload-problem]'), 'the limit')
    expect(problem.textContent).toBe('Die Datei ist zu groß, höchstens 250 MB.')
    expect(FakeXhr.all).toHaveLength(0)
  })

  it('says a file too large before it is sent, once the limits are known, and names the limit', async () => {
    limits = { video_max_mb: 1, other_max_mb: 1, ffmpeg: true }
    await show([])
    await click(button('Anhängen'))
    await choose('[data-pdf-input]', [file('dick.pdf', 2 * 1024 * 1024, 'application/pdf')])
    const problem = await until(() => document.querySelector('[data-upload-problem]'), 'the problem')
    expect(problem.textContent).toBe('Die Datei ist zu groß, höchstens 1 MB.')
    expect(document.querySelector('[data-upload]')!.parentElement!.textContent).toContain('Höchstens 1 MB je PDF. Zählt zu deinem Speicher.')
    expect(FakeXhr.all).toHaveLength(0)
  })

  it('stops the upload when the dialog is closed', async () => {
    await show([])
    await choose('[data-video-input]', [file('lang.mp4', 4096)])
    const sent = await until(() => FakeXhr.all[0], 'the upload')
    await click(button('Abbrechen'))
    expect(sent.aborted).toBe(true)
    expect(document.querySelector('[data-upload]')).toBeNull()
    expect(box.querySelectorAll('[data-attachment]')).toHaveLength(0)
  })
})

describe('the HEVC question', () => {
  async function uploadHevc(canConvert: boolean): Promise<void> {
    await show([])
    await choose('[data-video-input]', [file('IMG_4021.MOV', 100, 'video/quicktime')])
    const sent = await until(() => FakeXhr.all[0], 'the upload')
    await sent.answer(201, item(6, 'video', { name: 'IMG_4021', codec: 'hevc', playable: false, can_convert: canConvert }))
  }

  it('asks right after the upload; "Umwandeln" has the server convert it, and the tile says so', async () => {
    convertAnswer = item(6, 'video', { name: 'IMG_4021', codec: 'hevc', playable: false, status: 'queued' })
    await uploadHevc(true)
    const question = await until(() => document.querySelector('[data-hevc-question]'), 'the question')
    expect(question.textContent).toContain('„IMG_4021“ ist im Format HEVC.')
    await click(button('Umwandeln'))
    await idle()
    expect(calls.filter((call) => call.method === 'POST' && call.url === `/api/attachments/${hex(6)}/convert`)).toHaveLength(1)
    expect(document.querySelector('[data-hevc-question]')).toBeNull()
    expect(box.querySelector(`[data-attachment="${hex(6)}"] [data-converting]`)!.textContent).toContain('In der Warteschlange')
  })

  it('leaves the video as it is on "So lassen"', async () => {
    await uploadHevc(true)
    await until(() => document.querySelector('[data-hevc-question]'), 'the question')
    await click(button('So lassen'))
    await idle()
    expect(calls.some((call) => call.url.endsWith('/convert'))).toBe(false)
    expect(document.querySelector('[data-hevc-question]')).toBeNull()
    expect(box.querySelector(`[data-attachment="${hex(6)}"] [data-hevc]`)).not.toBeNull()
  })

  it('does not ask when the server does not offer to convert it', async () => {
    await uploadHevc(false)
    await eventually(() => expect(document.querySelector('[data-upload]')).toBeNull())
    expect(document.querySelector('[data-hevc-question]')).toBeNull()
    expect(box.querySelector(`[data-attachment="${hex(6)}"]`)).not.toBeNull()
  })

  it('offers to convert in the player of an HEVC video, and says when converting failed', async () => {
    convertAnswer = item(6, 'video', { codec: 'hevc', status: 'converting', progress: 0 })
    await show([item(6, 'video', { name: 'Pilz', codec: 'hevc', playable: false, can_convert: true, has_preview: true })])
    await click(box.querySelector(`[data-attachment="${hex(6)}"] button`))
    const player = document.querySelector<HTMLVideoElement>('[data-video-view] video')!
    expect(player.getAttribute('src')).toBe(`/api/attachments/${hex(6)}`)
    expect(player.getAttribute('preload')).toBe('metadata')
    expect(player.hasAttribute('controls')).toBe(true)
    expect(player.hasAttribute('playsinline')).toBe(true)
    expect(player.getAttribute('poster')).toBe(`/api/attachments/${hex(6)}/preview`)
    expect(document.querySelector<HTMLAnchorElement>('a[download]')!.getAttribute('href')).toBe(`/api/attachments/${hex(6)}?download=1`)
    expect(document.querySelector('[data-hevc-hint]')!.textContent).toContain('Dieses Video ist HEVC.')
    await click(button('Jetzt in H.264 umwandeln'))
    await idle()
    expect(document.body.textContent).toContain('Wird gerade in H.264 umgewandelt (0 %). Bis dahin läuft das Original.')
    act(() => root.unmount())
    await show([item(6, 'video', { codec: 'hevc', status: 'failed', can_convert: false })])
    await click(box.querySelector(`[data-attachment="${hex(6)}"] button`))
    expect(document.querySelector('[data-convert-failed]')!.textContent).toBe('Das Umwandeln hat nicht geklappt. Das Original ist geblieben, wie es war.')
    expect(button('Jetzt in H.264 umwandeln')).toBeUndefined()
  })
})

describe('asking how far the converting is', () => {
  it('asks while a video converts, shows the progress, and stops once it is done', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    lists = [[item(6, 'video', { codec: 'hevc', status: 'converting', progress: 40 })], [item(6, 'video', { codec: 'h264', status: 'ready' })]]
    await show([item(6, 'video', { codec: 'hevc', status: 'converting', progress: 5 })], { editable: true, pollMs: 3000 })
    const asked = () => calls.filter((call) => call.method === 'GET' && call.url === `/api/attachments?date=${DATE}`).length
    expect(asked()).toBe(0)
    expect(box.querySelector('[data-converting]')!.textContent).toContain('Wird umgewandelt · 5 %')
    await act(async () => vi.advanceTimersByTime(3000))
    await idle()
    expect(asked()).toBe(1)
    expect(box.querySelector('[data-converting]')!.textContent).toContain('Wird umgewandelt · 40 %')
    await act(async () => vi.advanceTimersByTime(3000))
    await idle()
    expect(asked()).toBe(2)
    expect(box.querySelector('[data-converting]')).toBeNull()
    expect(box.querySelector(`[data-attachment="${hex(6)}"]`)!.getAttribute('data-status')).toBe('ready')
    await act(async () => vi.advanceTimersByTime(30_000))
    await idle()
    expect(asked()).toBe(2)
  })

  it('never asks for a day without anything converting, and stops when the page is left', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await show([item(1, 'video')], { editable: true, pollMs: 3000 })
    await act(async () => vi.advanceTimersByTime(30_000))
    await idle()
    expect(calls.filter((call) => call.url.startsWith('/api/attachments?'))).toHaveLength(0)
    act(() => root.unmount())
    lists = [[item(6, 'video', { status: 'queued' })]]
    await show([item(6, 'video', { status: 'queued' })], { editable: true, pollMs: 3000 })
    await act(async () => vi.advanceTimersByTime(3000))
    await idle()
    expect(calls.filter((call) => call.url.startsWith('/api/attachments?'))).toHaveLength(1)
    act(() => root.unmount())
    await act(async () => vi.advanceTimersByTime(30_000))
    await idle()
    expect(calls.filter((call) => call.url.startsWith('/api/attachments?'))).toHaveLength(1)
  })
})

describe('asking less, and giving up', () => {
  /** One tick of the asking after the other; the number of requests after each. */
  async function ticks(count: number): Promise<number[]> {
    const seen: number[] = []
    for (let tick = 0; tick < count; tick++) {
      await act(async () => vi.advanceTimersByTime(1000))
      await idle()
      seen.push(calls.filter((call) => call.method === 'GET' && call.url === `/api/attachments?date=${DATE}`).length)
    }
    return seen
  }

  it('asks less often while a video only waits (the operator switched converting off), then stops', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    lists = [[item(6, 'video', { codec: 'hevc', status: 'queued' })]]
    await show([item(6, 'video', { codec: 'hevc', status: 'queued' })], { editable: true, pollMs: 1000 })
    const seen = await ticks(200)
    // Asked after 1, 3, 7, 15, 25 … seconds: the wait doubles up to ten steps.
    expect([seen[0], seen[1], seen[2], seen[6], seen[14], seen[24], seen[34]]).toEqual([1, 1, 2, 3, 4, 5, 6])
    expect(seen.at(-1)).toBe(12)
    expect((await ticks(100)).at(-1)).toBe(12)
    expect(box.querySelector('[data-converting]')!.textContent).toContain('In der Warteschlange')
  })

  it('starts quick again when the video moves', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const queued = item(6, 'video', { codec: 'hevc', status: 'queued' })
    lists = [[queued], [queued], [queued], [item(6, 'video', { status: 'converting', progress: 10 })], [item(6, 'video', { status: 'converting', progress: 20 })]]
    await show([queued], { editable: true, pollMs: 1000 })
    const seen = await ticks(16)
    // 1, 3, 7: unchanged; at 15 it moved, so the next asking comes one tick later.
    expect([seen[6], seen[14], seen[15]]).toEqual([3, 4, 5])
  })

  it('stops after the server failed a few times in a row', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    listFails = 500
    await show([item(6, 'video', { status: 'converting', progress: 30 })], { editable: true, pollMs: 1000 })
    const seen = await ticks(120)
    expect(seen.at(-1)).toBe(4)
    expect((await ticks(60)).at(-1)).toBe(4)
  })
})

describe('the drawn first pages of PDFs', () => {
  it('are kept per file, and let go when the PDF is deleted', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private readonly told: (entries: { isIntersecting: boolean }[]) => void) {}
        observe() {
          this.told([{ isIntersecting: true }])
        }
        disconnect() {}
      },
    )
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA')
    await show([item(5, 'pdf', { name: 'Elternbrief.pdf' }), item(4, 'pdf', { name: 'Speiseplan.pdf' })])
    await until(() => box.querySelectorAll('[data-kind="pdf"] img').length === 2, 'the first pages')
    expect(box.querySelector(`[data-attachment="${hex(5)}"]`)!.textContent).toContain('PDF · 3 Seiten')
    expect(thumbCount()).toBe(2)
    await click(box.querySelector(`[data-attachment="${hex(5)}"] button[aria-label="Anhang löschen"]`))
    await click(document.querySelector('[data-remove-confirm]'))
    await idle()
    expect(thumbCount()).toBe(1)
    toDataURL.mockRestore()
  })
})

describe('a link', () => {
  const submit = () => document.querySelector('[data-link-form] button[type="submit"]')
  async function openLink(): Promise<HTMLInputElement> {
    await show([])
    await click(button('Anhängen'))
    await click(button('Link'))
    return document.querySelector<HTMLInputElement>('[data-link-form] input[type="url"]')!
  }

  it('is checked before it is sent: http or https, a whole address, no name and password in it', async () => {
    const field = await openLink()
    expect(document.querySelector('[data-link-form]')!.textContent).toContain('nexdiary ruft die Seite nicht auf. Sie öffnet sich erst, wenn du den Link antippst.')
    for (const wrong of ['strandbad.example.com', 'ftp://example.com/x', 'https://exa mple.com', 'https://user:pass@example.com/', 'javascript:alert(1)', 'https://localhost.']) {
      await type(field, wrong)
      await click(submit())
      expect(document.querySelector('[data-link-invalid]')?.textContent, wrong).toBe('Bitte eine ganze Adresse mit http:// oder https://.')
    }
    expect(calls.some((call) => call.url === '/api/attachments/link')).toBe(false)
  })

  it('sends the address, the title or none, the day and an id, and adds the link', async () => {
    const field = await openLink()
    await type(field, ' https://markt.example.com/samstag ')
    await act(async () => document.querySelector('[data-link-form]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await idle()
    const sent = calls.find((call) => call.url === '/api/attachments/link')!
    expect(sent.method).toBe('POST')
    expect(sent.body).toMatchObject({ date: DATE, url: 'https://markt.example.com/samstag', title: null })
    expect((sent.body as { upload_id: string }).upload_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(document.querySelector('[data-link-form]')).toBeNull()
    expect(box.querySelector(`[data-attachment="${hex(9)}"] a`)!.getAttribute('href')).toBe('https://markt.example.com/samstag')
  })

  it('shows the server refusing the address at the field', async () => {
    linkAnswer = { status: 422, body: { detail: { code: 'invalid_input', fields: ['url'], message: 'x' } } }
    const field = await openLink()
    await type(field, 'https://example.com/ok')
    await click(submit())
    await idle()
    expect(document.querySelector('[data-link-invalid]')).not.toBeNull()
    expect(document.querySelector('[data-link-form]')).not.toBeNull()
  })
})

describe('deleting', () => {
  it('asks first, says what goes, and keeps it on "Behalten"', async () => {
    await show([item(2, 'audio', { name: 'Lied im Auto' })])
    await click(box.querySelector(`[data-attachment="${hex(2)}"] button[aria-label="Anhang löschen"]`))
    expect(document.body.textContent).toContain('„Lied im Auto“ verschwindet von diesem Tag und aus deinem Speicher.')
    await click(button('Behalten'))
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    expect(box.querySelector(`[data-attachment="${hex(2)}"]`)).not.toBeNull()
    await click(box.querySelector(`[data-attachment="${hex(2)}"] button[aria-label="Anhang löschen"]`))
    await click(document.querySelector('[data-remove-confirm]'))
    await idle()
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.url)).toEqual([`/api/attachments/${hex(2)}`])
    expect(box.querySelector(`[data-attachment="${hex(2)}"]`)).toBeNull()
  })

  it('offers no delete while a video converts', async () => {
    await show([item(6, 'video', { status: 'converting', progress: 10 })], { editable: true, pollMs: 60_000 })
    expect(box.querySelector(`[data-attachment="${hex(6)}"] button[aria-label="Anhang löschen"]`)).toBeNull()
  })
})

describe('a shared day', () => {
  it('is read only, and every file comes through the share', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const source = { owner: 2, date: DATE }
    await show([item(1, 'video', { has_preview: true }), item(2, 'audio'), item(5, 'pdf'), item(6, 'video', { status: 'converting', progress: 3 })], { source, pollMs: 3000 })
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(button('Anhängen')).toBeUndefined()
    expect(box.querySelector('button[aria-label="Anhang löschen"]')).toBeNull()
    expect(box.querySelector(`[data-attachment="${hex(1)}"] img`)!.getAttribute('src')).toBe(`/api/shared/2/${DATE}/attachments/${hex(1)}/preview`)
    expect(box.querySelector(`[data-attachment="${hex(2)}"] audio`)!.getAttribute('src')).toBe(`/api/shared/2/${DATE}/attachments/${hex(2)}`)
    await click(box.querySelector(`[data-attachment="${hex(1)}"] button`))
    expect(document.querySelector('[data-video-view] video')!.getAttribute('src')).toBe(`/api/shared/2/${DATE}/attachments/${hex(1)}`)
    expect(document.querySelector('a[download]')!.getAttribute('href')).toBe(`/api/shared/2/${DATE}/attachments/${hex(1)}?download=1`)
    // Nothing of the own routes, and no asking about the conversion of somebody else's video.
    await idle()
    expect(calls.filter((call) => call.url.startsWith('/api/attachments') && call.url !== '/api/attachments/limits')).toEqual([])
  })
})

describe('the PDF reader', () => {
  it('opens on the first page and leafs through them', async () => {
    await show([item(5, 'pdf', { name: 'Elternbrief.pdf' })])
    await click(box.querySelector(`[data-attachment="${hex(5)}"] button`))
    await until(() => document.body.textContent?.includes('Seite 1 von 3'), 'the reader')
    await click(button('Nächste Seite'))
    expect(document.body.textContent).toContain('Seite 2 von 3')
    await click(button('Vorige Seite'))
    expect(document.body.textContent).toContain('Seite 1 von 3')
    expect(button('Vorige Seite')!.disabled).toBe(true)
    expect(document.querySelector<HTMLAnchorElement>('a[download]')!.getAttribute('href')).toBe(`/api/attachments/${hex(5)}?download=1`)
  })
})
