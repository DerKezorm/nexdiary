/**
 * A voice recording in the browser (`MediaRecorder` on the microphone). The format is the first one the browser can
 * make and the server takes: Opus in WebM (Chrome, Firefox, newer Safari), else AAC in MP4 (Safari). It stops by itself
 * after 30 minutes. The clock is handed in, so that the tests need not wait half an hour.
 */

export const MAX_SECONDS = 30 * 60

/** In this order: the first the browser says it can record. */
export const FORMATS = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm'] as const

/** Why there can be no recording here, or null when there can be one. */
export type Missing = 'insecure' | 'unsupported' | null

type Env = {
  secure: boolean
  mediaDevices?: { getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream> }
  Recorder?: { new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder; isTypeSupported?: (type: string) => boolean }
}

function env(): Env {
  return {
    secure: typeof window !== 'undefined' && window.isSecureContext !== false,
    mediaDevices: typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined,
    Recorder: typeof MediaRecorder !== 'undefined' ? MediaRecorder : undefined,
  }
}

/** The microphone needs https (or localhost) and a browser with `MediaRecorder`. */
export function missing(at: Env = env()): Missing {
  if (!at.secure) return 'insecure'
  if (!at.mediaDevices?.getUserMedia || !at.Recorder) return 'unsupported'
  return null
}

/** The format to record in; '' when the browser names none of ours (it then picks its own, the server decides). */
export function chooseFormat(at: Env = env()): string {
  const supported = at.Recorder?.isTypeSupported
  if (!supported) return ''
  return FORMATS.find((type) => supported.call(at.Recorder, type)) ?? ''
}

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopped'

export type RecordingResult = { blob: Blob; seconds: number; type: string }

/**
 * One recording: `start` asks for the microphone (a refusal is thrown as `denied`), `stop` ends it, `tick` (called
 * every few hundred milliseconds by the page) gives the seconds so far and stops at 30 minutes on its own.
 */
export class Recording {
  state: RecorderState = 'idle'
  type = ''
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private parts: Blob[] = []
  private began = 0
  private ended = 0
  private finished: Promise<RecordingResult> | null = null
  /** Counts the cancels: a start that was waiting for the browser's question sees that it was called off meanwhile. */
  private round = 0
  private readonly now: () => number
  private readonly at: Env
  /** Told once when the recording stopped by itself (the 30 minutes were full). */
  onLimit?: () => void

  constructor(options: { now?: () => number; env?: Env } = {}) {
    this.now = options.now ?? (() => Date.now())
    this.at = options.env ?? env()
  }

  /** The microphone stream while it records (for the level shown), else null. */
  get source(): MediaStream | null {
    return this.stream
  }

  /** Starts recording; resolves without recording when `cancel` came while the browser was still asking (then the
   * microphone it granted is let go at once: `state` stays `idle`). */
  async start(): Promise<void> {
    if (this.state !== 'idle') return
    const why = missing(this.at)
    if (why) throw new Error(why)
    this.state = 'starting'
    const mine = this.round
    let stream: MediaStream
    try {
      stream = await this.at.mediaDevices!.getUserMedia!({ audio: true })
    } catch (error) {
      if (mine !== this.round) return
      this.state = 'idle'
      const name = error instanceof Error || (error && typeof error === 'object') ? String((error as { name?: unknown }).name ?? '') : ''
      throw new Error(name === 'NotFoundError' || name === 'OverconstrainedError' ? 'no_microphone' : 'denied', { cause: error })
    }
    if (mine !== this.round) {
      // Called off while the browser asked (the dialog was closed): the microphone goes off, nothing records.
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    this.stream = stream
    this.type = chooseFormat(this.at)
    const Recorder = this.at.Recorder!
    const recorder = this.type ? new Recorder(stream, { mimeType: this.type }) : new Recorder(stream)
    this.recorder = recorder
    this.parts = []
    this.finished = new Promise((resolve) => {
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) this.parts.push(event.data)
      }
      recorder.onstop = () => {
        const type = recorder.mimeType || this.type || this.parts[0]?.type || 'audio/webm'
        this.release()
        resolve({ blob: new Blob(this.parts, { type }), seconds: this.seconds(), type })
      }
    })
    // A part every second: a recording cut short (the tab closed) loses at most that.
    recorder.start(1000)
    this.began = this.now()
    this.state = 'recording'
  }

  /** The seconds recorded so far (or in all, once it stopped). */
  seconds(): number {
    if (this.state === 'idle' || this.state === 'starting') return 0
    const end = this.state === 'stopped' ? this.ended : this.now()
    return Math.max(0, Math.min(MAX_SECONDS, (end - this.began) / 1000))
  }

  /** Called by the page now and then: the seconds so far; at 30 minutes it stops by itself. */
  tick(): number {
    if (this.state === 'recording' && (this.now() - this.began) / 1000 >= MAX_SECONDS) {
      void this.stop()
      this.onLimit?.()
    }
    return this.seconds()
  }

  /** Ends the recording; the file, or null when nothing was recorded. */
  async stop(): Promise<RecordingResult | null> {
    if (this.state !== 'recording' || !this.recorder || !this.finished) return this.state === 'stopped' && this.finished ? this.finished : null
    this.ended = this.now()
    this.state = 'stopped'
    try {
      if (this.recorder.state !== 'inactive') this.recorder.stop()
    } catch {
      this.release()
    }
    return this.finished
  }

  /** Throws the recording away and frees the microphone. */
  cancel(): void {
    this.round += 1
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null
      try {
        this.recorder.stop()
      } catch {
        // Gone already.
      }
    }
    this.release()
    this.state = 'idle'
    this.parts = []
    this.finished = null
  }

  /** The microphone's light goes out. */
  private release(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
  }
}
