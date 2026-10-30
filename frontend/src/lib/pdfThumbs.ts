/**
 * The first pages of PDFs drawn in this tab, so that a tile shown again need not draw anew. Bound to the file (address
 * and size: a file replaced under the same id is drawn again), at most `MAX` pictures (the oldest seen goes first),
 * forgotten when an attachment is deleted and when the person signs out.
 */

export type Thumb = { picture: string; pages: number }

export const MAX = 24
const drawn = new Map<string, Thumb>()

const keyOf = (src: string, size: number) => `${src}#${size}`

export function thumbOf(src: string, size: number): Thumb | null {
  const key = keyOf(src, size)
  const found = drawn.get(key)
  if (!found) return null
  // Seen again: the newest now.
  drawn.delete(key)
  drawn.set(key, found)
  return found
}

export function keepThumb(src: string, size: number, thumb: Thumb): void {
  forgetThumb(src)
  drawn.set(keyOf(src, size), thumb)
  while (drawn.size > MAX) drawn.delete(drawn.keys().next().value as string)
}

/** Every picture of this address, whatever size it had. */
export function forgetThumb(src: string): void {
  for (const key of [...drawn.keys()]) if (key.slice(0, key.lastIndexOf('#')) === src) drawn.delete(key)
}

export function forgetThumbs(): void {
  drawn.clear()
}

export function thumbCount(): number {
  return drawn.size
}
