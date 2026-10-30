/** Small helpers for the attachments of a day: times, hosts, the drawn waveform of a recording. */

/** "1:24": seconds as minutes and seconds, "1:02:05" from an hour on. */
export function clock(seconds: number | null | undefined = 0): string {
  const total = Math.max(0, Math.floor(seconds ?? 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

/** The host of an address ("strandbad.example.com"), or the address itself when it is none. */
export function hostOf(url = ''): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** A waveform that stays the same for the same recording: `n` heights between a quarter and the whole. Drawn from the
 * id, not from the sound (nexdiary never reads the sound). */
export function bars(seed: string, n: number): number[] {
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return Array.from({ length: n }, () => {
    h = (h * 1103515245 + 12345) >>> 0
    return 0.25 + ((h >>> 16) % 1000) / 1333
  })
}

/**
 * Whether an address may be attached: http or https, a host with a dot (or localhost), no spaces, no name and password
 * in it, at most 2,048 characters. The server checks the same and says `invalid_input` otherwise.
 */
export function linkOk(raw: string): boolean {
  const url = raw.trim()
  if (!url || url.length > 2048 || /\s/.test(url) || !/^https?:\/\//i.test(url)) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.username || parsed.password) return false
  return parsed.hostname === 'localhost' || /\.[^.]+$/.test(parsed.hostname)
}
