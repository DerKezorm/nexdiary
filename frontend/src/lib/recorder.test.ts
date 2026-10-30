/**
 * The voice recording: the format chosen by what the browser can record (Safari AAC in MP4, the others Opus in WebM),
 * the stop by itself after 30 minutes on a clock handed in, and the ways there is no recording (no https, no
 * MediaRecorder, the microphone refused or missing).
 */
import { chooseFormat, MAX_SECONDS, missing, Recording } from './recorder'

class FakeRecorder {
  static supported = new Set<string>()
  static made: FakeRecorder[] = []
  static isTypeSupported(type: string) {
    return FakeRecorder.supported.has(type)
  }
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? ''
    FakeRecorder.made.push(this)
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

function stream() {
  const track = { stop: vi.fn() }
  return { track, stream: { getTracks: () => [track] } as unknown as MediaStream }
}

function env(over: Partial<{ secure: boolean; getUserMedia: () => Promise<MediaStream>; Recorder: unknown }> = {}) {
  const { stream: given } = stream()
  return {
    secure: over.secure ?? true,
    mediaDevices: { getUserMedia: over.getUserMedia ?? (async () => given) },
    Recorder: (('Recorder' in over ? over.Recorder : FakeRecorder) as never),
  }
}

beforeEach(() => {
  FakeRecorder.supported = new Set()
  FakeRecorder.made = []
})

describe('the format', () => {
  it('is Opus in WebM where the browser records it', () => {
    FakeRecorder.supported = new Set(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'])
    expect(chooseFormat(env())).toBe('audio/webm;codecs=opus')
  })

  it('is AAC in MP4 in Safari, which records no WebM', () => {
    FakeRecorder.supported = new Set(['audio/mp4'])
    expect(chooseFormat(env())).toBe('audio/mp4')
    FakeRecorder.supported = new Set(['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'])
    expect(chooseFormat(env())).toBe('audio/mp4;codecs=mp4a.40.2')
  })

  it('is left to the browser when it names none of them', async () => {
    expect(chooseFormat(env())).toBe('')
    const take = new Recording({ env: env() })
    await take.start()
    expect(FakeRecorder.made[0].mimeType).toBe('')
  })

  it('is what the recording is made in', async () => {
    FakeRecorder.supported = new Set(['audio/mp4'])
    const take = new Recording({ env: env() })
    await take.start()
    expect(FakeRecorder.made[0].mimeType).toBe('audio/mp4')
    const result = await take.stop()
    expect(result!.blob.type).toBe('audio/mp4')
  })
})

describe('the 30 minutes', () => {
  it('stop the recording by itself, on the clock handed in, and free the microphone', async () => {
    let now = 1_000_000
    const { track, stream: given } = stream()
    const take = new Recording({ now: () => now, env: { ...env(), mediaDevices: { getUserMedia: async () => given } } })
    const limit = vi.fn()
    take.onLimit = limit
    await take.start()
    expect(take.state).toBe('recording')
    now += 29 * 60 * 1000 + 59_000
    expect(take.tick()).toBe(29 * 60 + 59)
    expect(take.state).toBe('recording')
    expect(limit).not.toHaveBeenCalled()
    now += 1000
    take.tick()
    expect(take.state).toBe('stopped')
    expect(limit).toHaveBeenCalledTimes(1)
    expect(FakeRecorder.made[0].state).toBe('inactive')
    expect(track.stop).toHaveBeenCalled()
    // Later ticks change nothing, and the length stays the 30 minutes.
    now += 60_000
    take.tick()
    expect(limit).toHaveBeenCalledTimes(1)
    expect(take.seconds()).toBe(MAX_SECONDS)
    const result = await take.stop()
    expect(result!.seconds).toBe(MAX_SECONDS)
    expect(result!.blob.size).toBeGreaterThan(0)
  })

  it('a recording stopped by hand keeps its own length', async () => {
    let now = 0
    const take = new Recording({ now: () => now, env: env() })
    await take.start()
    now = 42_500
    const result = await take.stop()
    expect(result!.seconds).toBe(42.5)
  })
})

describe('letting the microphone go', () => {
  it('cancel stops a running recording and frees the microphone', async () => {
    const { track, stream: given } = stream()
    const take = new Recording({ env: { ...env(), mediaDevices: { getUserMedia: async () => given } } })
    await take.start()
    take.cancel()
    expect(track.stop).toHaveBeenCalled()
    expect(FakeRecorder.made[0].state).toBe('inactive')
    expect(take.state).toBe('idle')
    expect(take.source).toBeNull()
  })

  it('a cancel while the browser still asks lets the microphone go the moment it is granted, and records nothing', async () => {
    const { track, stream: given } = stream()
    let grant: (value: MediaStream) => void = () => undefined
    const asked = new Promise<MediaStream>((resolve) => {
      grant = resolve
    })
    const take = new Recording({ env: { ...env(), mediaDevices: { getUserMedia: () => asked } } })
    const starting = take.start()
    expect(take.state).toBe('starting')
    take.cancel()
    grant(given)
    await starting
    expect(take.state).toBe('idle')
    expect(take.source).toBeNull()
    expect(FakeRecorder.made).toHaveLength(0)
    expect(track.stop).toHaveBeenCalledTimes(1)
  })
})

describe('no recording', () => {
  it('without https', () => {
    expect(missing(env({ secure: false }))).toBe('insecure')
  })

  it('without MediaRecorder or microphone access in the browser', () => {
    expect(missing(env({ Recorder: undefined }))).toBe('unsupported')
    expect(missing({ secure: true, Recorder: FakeRecorder as never })).toBe('unsupported')
    expect(missing(env())).toBeNull()
  })

  it('says whether the microphone was refused or is missing', async () => {
    const refused = Object.assign(new Error('no'), { name: 'NotAllowedError' })
    await expect(new Recording({ env: env({ getUserMedia: async () => Promise.reject(refused) }) }).start()).rejects.toThrow('denied')
    const none = Object.assign(new Error('no'), { name: 'NotFoundError' })
    await expect(new Recording({ env: env({ getUserMedia: async () => Promise.reject(none) }) }).start()).rejects.toThrow('no_microphone')
    await expect(new Recording({ env: env({ secure: false }) }).start()).rejects.toThrow('insecure')
    expect(FakeRecorder.made).toHaveLength(0)
  })
})
