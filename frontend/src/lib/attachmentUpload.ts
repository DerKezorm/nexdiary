/**
 * Uploading a video, a recording or a PDF to a day, with its progress (fetch cannot report how far an upload got, an
 * XMLHttpRequest can) and a way to stop it. Each file carries an id made here: sent again after the network dropped
 * (a train tunnel, a sleeping phone), the server keeps one attachment. A file larger than the server takes is said
 * before a byte goes out, once the limits are known: from the server, or from a refusal that named them.
 */
import i18n from 'i18next'

import { ApiError, attachmentsApi, SIGNED_OUT_EVENT, tabId, type Attachment, type AttachmentLimits } from '../api/client'
import { newId } from './ids'

export type FileKind = 'video' | 'audio' | 'pdf'

/** What the file pickers offer. Video and audio of any kind (a list of types hides the camera on some phones); the
 * server decides from the content what it takes. */
export const ACCEPT: Record<FileKind, string> = { video: 'video/*', audio: 'audio/*', pdf: 'application/pdf,.pdf' }

/** A name as the server keeps it: no control characters, no path separators, no line breaks, at most 120 characters. */
export function cleanName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\x00-\x1f\x7f/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).trim()
}

/** The name an uploaded file starts with: a video or a recording without its ending ("IMG_4021"), a PDF with it. */
export function nameOfFile(file: File | Blob, kind: FileKind, fallback: string): string {
  const raw = 'name' in file && typeof file.name === 'string' ? file.name : ''
  const name = kind === 'pdf' ? raw : raw.replace(/\.[A-Za-z0-9]{1,5}$/, '')
  return cleanName(name) || fallback
}

// --- The limits ------------------------------------------------------------------------------------------------------

const MB = 1024 * 1024
let known: Partial<AttachmentLimits> = {}
let asked: Promise<Partial<AttachmentLimits>> | null = null

/** The limits as far as they are known; asked of the server once per page load (an answer that is not one leaves
 * them unknown, and the server says it on the upload instead). */
export function loadLimits(): Promise<Partial<AttachmentLimits>> {
  if (!asked)
    asked = attachmentsApi.limits().then(
      (found) => {
        if (found && typeof found === 'object' && !Array.isArray(found)) {
          if (typeof found.video_max_mb === 'number') known.video_max_mb = found.video_max_mb
          if (typeof found.other_max_mb === 'number') known.other_max_mb = found.other_max_mb
          if (typeof found.ffmpeg === 'boolean') known.ffmpeg = found.ffmpeg
        }
        return known
      },
      () => known,
    )
  return asked
}

/** A refusal named the largest size: the next file of that kind is checked against it before it goes out. */
export function learnLimit(kind: FileKind, maxMb: unknown): void {
  if (typeof maxMb !== 'number' || !Number.isFinite(maxMb) || maxMb <= 0) return
  if (kind === 'video') known.video_max_mb = maxMb
  else known.other_max_mb = maxMb
}

/** The operator changed the limits (their own card): the page goes on with these. */
export function setLimits(limits: Partial<AttachmentLimits>): void {
  known = { ...known, ...limits }
  asked = Promise.resolve(known)
}

export function knownLimits(): Partial<AttachmentLimits> {
  return known
}

/** For the tests: as on a fresh page. */
export function forgetLimits(): void {
  known = {}
  asked = null
}

/** The largest size in MB when the file is larger than that, else null (also while the limit is not known). */
export function tooLarge(file: Blob, kind: FileKind, limits: Partial<AttachmentLimits> = known): number | null {
  const max = kind === 'video' ? limits.video_max_mb : limits.other_max_mb
  return typeof max === 'number' && file.size > max * MB ? max : null
}

// --- The upload ------------------------------------------------------------------------------------------------------

export type Upload = {
  /** The attachment the server keeps, or an `ApiError` (`aborted` when it was stopped). */
  done: Promise<Attachment>
  abort: () => void
  uploadId: string
}

type Send = { file: Blob; kind: FileKind; name: string; date?: string; uploadId: string; onProgress?: (fraction: number) => void }

function errorOf(status: number, text: string, retryAfter: string | null = null): ApiError {
  let data: { detail?: unknown } | null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  const detail = data?.detail as { code?: unknown; message?: unknown } | undefined
  if (detail && typeof detail === 'object' && typeof detail.code === 'string') {
    const { code, message: _message, ...values } = detail as Record<string, unknown> & { code: string }
    if (code === 'sign_in_required') window.dispatchEvent(new Event(SIGNED_OUT_EVENT))
    const seconds = Number(retryAfter)
    return new ApiError(status, code, retryAfter !== null && Number.isFinite(seconds) && seconds >= 0 ? { ...values, retry_after: seconds } : values)
  }
  if (status === 413) return new ApiError(status, 'attachment_too_large')
  return new ApiError(status, status === 401 ? 'sign_in_required' : 'internal_error')
}

/** One try: the file as the body, as `POST /api/photos` takes a photo. */
function sendOnce({ file, kind, name, date, uploadId, onProgress }: Send, hold: (xhr: XMLHttpRequest) => void): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ upload_id: uploadId, kind, name })
    if (date) query.set('date', date)
    const xhr = new XMLHttpRequest()
    hold(xhr)
    xhr.open('POST', `/api/attachments?${query.toString()}`)
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader('X-Nexdiary-Client', tabId())
    if (i18n.language) xhr.setRequestHeader('X-Nexdiary-Language', i18n.language)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(Math.min(1, event.loaded / event.total))
    }
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201) {
        try {
          resolve(JSON.parse(xhr.responseText) as Attachment)
        } catch {
          reject(new ApiError(xhr.status, 'internal_error'))
        }
      } else reject(errorOf(xhr.status, xhr.responseText, xhr.getResponseHeader?.('Retry-After') ?? null))
    }
    xhr.onerror = () => reject(new ApiError(0, 'network'))
    xhr.ontimeout = () => reject(new ApiError(0, 'network'))
    xhr.onabort = () => reject(new ApiError(0, 'aborted'))
    xhr.send(file)
  })
}

const TRIES = 3
const WAIT_MS = 1500
/** The server takes one upload of a person at a time and answers a second with 503 `busy` and `Retry-After`. */
const BUSY_TRIES = 4
const BUSY_WAIT_MAX_MS = 30_000

/** How long a wait lasts; the tests make it short. */
export const timing = { wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) }

/** The uploads of this tab, one after the other: the next starts when the one before is done, whatever came of it. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Sends a file with its progress, after the uploads of this tab started before it. After a dropped or stalled
 * connection it tries again on its own, twice, with the same id; when the server is busy with another upload of the
 * person, it waits as long as the server says and tries again, a few times. `again` sends it once more by hand, still
 * with that id. A refusal of the server is not tried again.
 */
export function uploadAttachment(send: Omit<Send, 'uploadId'> & { uploadId?: string }): Upload {
  const uploadId = send.uploadId ?? newId()
  let current: XMLHttpRequest | null = null
  let stopped = false
  let stop: () => void = () => undefined
  const stopping = new Promise<void>((resolve) => {
    stop = resolve
  })
  const before = queue
  const done = (async () => {
    await Promise.race([before.catch(() => undefined), stopping])
    let failures = 0
    let busy = 0
    for (;;) {
      if (stopped) throw new ApiError(0, 'aborted')
      try {
        return await sendOnce({ ...send, uploadId }, (xhr) => (current = xhr))
      } catch (error) {
        if (error instanceof ApiError && error.code === 'attachment_too_large') learnLimit(send.kind, error.values.max_mb)
        if (stopped || !(error instanceof ApiError)) throw error
        let pause: number
        if (error.code === 'network' || error.code === 'upload_stalled') {
          failures += 1
          if (failures >= TRIES) throw error
          pause = WAIT_MS * failures
        } else if (error.code === 'busy' && error.status === 503) {
          busy += 1
          if (busy >= BUSY_TRIES) throw error
          const asked = typeof error.values.retry_after === 'number' ? error.values.retry_after * 1000 : 5000
          pause = Math.min(BUSY_WAIT_MAX_MS, Math.max(500, asked))
        } else throw error
        send.onProgress?.(0)
        await Promise.race([timing.wait(pause), stopping])
      }
    }
  })()
  queue = done.catch(() => undefined)
  return {
    done,
    uploadId,
    abort: () => {
      stopped = true
      stop()
      current?.abort()
    },
  }
}
