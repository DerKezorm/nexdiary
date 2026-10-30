/**
 * The upload of an attachment: one after the other in a tab (the server takes one upload of a person at a time), a
 * busy server waited for as long as it says, a stalled connection tried again like a dropped one, always with the same
 * id, and at last the refusal handed to the page.
 */
import { ApiError } from '../api/client'
import { timing, uploadAttachment } from './attachmentUpload'

class FakeXhr {
  static all: FakeXhr[] = []
  upload = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  ontimeout = null
  status = 0
  responseText = ''
  url = ''
  headers: Record<string, string> = {}
  open(_method: string, url: string) {
    this.url = url
  }
  setRequestHeader() {}
  getResponseHeader(name: string) {
    return this.headers[name.toLowerCase()] ?? null
  }
  send() {
    FakeXhr.all.push(this)
  }
  abort() {
    this.onabort?.()
  }
  get id() {
    return new URL(this.url, 'http://x').searchParams.get('upload_id')
  }
  answer(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status
    this.headers = headers
    this.responseText = JSON.stringify(body)
    this.onload?.()
  }
}

const waits: number[] = []
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
async function next(count: number): Promise<FakeXhr> {
  for (let round = 0; round < 50 && FakeXhr.all.length < count; round++) await settle()
  return FakeXhr.all[count - 1]
}
const file = () => new Blob([new Uint8Array(16)])
const kept = (id: string) => ({ id, kind: 'pdf', name: 'x', date: '2026-10-04' })

beforeEach(() => {
  FakeXhr.all = []
  waits.length = 0
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  vi.spyOn(timing, 'wait').mockImplementation(async (ms: number) => {
    waits.push(ms)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('sends the uploads of a tab one after the other, also when one fails', async () => {
  const first = uploadAttachment({ file: file(), kind: 'video', name: 'a' })
  const second = uploadAttachment({ file: file(), kind: 'audio', name: 'b' })
  const third = uploadAttachment({ file: file(), kind: 'pdf', name: 'c' })
  await next(1)
  await settle()
  expect(FakeXhr.all).toHaveLength(1)
  FakeXhr.all[0].answer(422, { detail: { code: 'attachment_not_supported', message: 'x' } })
  await expect(first.done).rejects.toMatchObject({ code: 'attachment_not_supported' })
  const sent = await next(2)
  expect(sent.id).toBe(second.uploadId)
  await settle()
  expect(FakeXhr.all).toHaveLength(2)
  sent.answer(201, kept('b'))
  await expect(second.done).resolves.toMatchObject({ id: 'b' })
  ;(await next(3)).answer(201, kept('c'))
  await expect(third.done).resolves.toMatchObject({ id: 'c' })
})

it('lets a waiting upload be stopped before it is sent, and the next goes on', async () => {
  const first = uploadAttachment({ file: file(), kind: 'video', name: 'a' })
  const second = uploadAttachment({ file: file(), kind: 'pdf', name: 'b' })
  const third = uploadAttachment({ file: file(), kind: 'pdf', name: 'c' })
  second.abort()
  await expect(second.done).rejects.toMatchObject({ code: 'aborted' })
  ;(await next(1)).answer(201, kept('a'))
  await first.done
  const sent = await next(2)
  expect(sent.id).toBe(third.uploadId)
  sent.answer(201, kept('c'))
  await third.done
  expect(FakeXhr.all).toHaveLength(2)
})

it('waits as long as a busy server says, with the same id, and gives up after a few times', async () => {
  const upload = uploadAttachment({ file: file(), kind: 'video', name: 'a' })
  for (let round = 1; round <= 4; round++) (await next(round)).answer(503, { detail: { code: 'busy', message: 'x' } }, { 'retry-after': '5' })
  const failed = await upload.done.catch((error: unknown) => error)
  expect(failed).toBeInstanceOf(ApiError)
  expect((failed as ApiError).code).toBe('busy')
  expect(waits).toEqual([5000, 5000, 5000])
  expect(new Set(FakeXhr.all.map((xhr) => xhr.id))).toEqual(new Set([upload.uploadId]))
})

it('goes on when the busy server is free again', async () => {
  const upload = uploadAttachment({ file: file(), kind: 'video', name: 'a' })
  ;(await next(1)).answer(503, { detail: { code: 'busy', message: 'x' } }, { 'retry-after': '2' })
  ;(await next(2)).answer(201, kept('a'))
  await expect(upload.done).resolves.toMatchObject({ id: 'a' })
  expect(waits).toEqual([2000])
})

it('tries a stalled connection again like a dropped one, with the same id', async () => {
  const upload = uploadAttachment({ file: file(), kind: 'video', name: 'a' })
  for (let round = 1; round <= 3; round++) (await next(round)).answer(408, { detail: { code: 'upload_stalled', message: 'x' } })
  await expect(upload.done).rejects.toMatchObject({ code: 'upload_stalled' })
  expect(FakeXhr.all.map((xhr) => xhr.id)).toEqual([upload.uploadId, upload.uploadId, upload.uploadId])
  expect(waits).toEqual([1500, 3000])
})
