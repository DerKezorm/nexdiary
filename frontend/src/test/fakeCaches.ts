/**
 * A stand-in for the browser's Cache Storage, enough for the shared photos: named caches holding answers under
 * addresses. An answer is kept as it was put (the service worker puts real `Response`s, a test may put anything with
 * `json()` and `blob()`); addresses are made whole against the origin given, as a browser does.
 */
export type Kept = { json(): Promise<unknown>; blob(): Promise<Blob> }

export class FakeCache {
  readonly entries = new Map<string, Kept>()
  /** After this many more puts, every put fails (a full storage). */
  failAfter = Infinity

  constructor(private readonly origin: string) {}

  private whole(key: string | { url: string }): string {
    return new URL(typeof key === 'string' ? key : key.url, this.origin).href
  }

  async put(key: string | { url: string }, answer: Kept): Promise<void> {
    if (this.failAfter <= 0) throw new DOMException('full', 'QuotaExceededError')
    this.failAfter -= 1
    this.entries.set(this.whole(key), answer)
  }

  async match(key: string | { url: string }): Promise<Kept | undefined> {
    return this.entries.get(this.whole(key))
  }

  async keys(): Promise<{ url: string }[]> {
    return [...this.entries.keys()].map((url) => ({ url }))
  }

  async delete(key: string | { url: string }): Promise<boolean> {
    return this.entries.delete(this.whole(key))
  }
}

export class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>()

  constructor(private readonly origin: string) {}

  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name)
    if (!cache) {
      cache = new FakeCache(this.origin)
      this.caches.set(name, cache)
    }
    return cache
  }

  async has(name: string): Promise<boolean> {
    return this.caches.has(name)
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name)
  }

  /** Every address kept, in all caches. */
  addresses(): string[] {
    return [...this.caches.values()].flatMap((cache) => [...cache.entries.keys()])
  }
}

/** A kept answer as a test writes it: JSON for the description of a share, a picture for a photo. */
export function kept(value: unknown): Kept {
  return {
    json: async () => value,
    blob: async () => (value instanceof Blob ? value : new Blob([JSON.stringify(value)])),
  }
}

/** A share as the service worker keeps it, written straight into the stand-in. */
export async function keepShare(storage: FakeCacheStorage, id: string, at: number, photos: Blob[], words: { title?: string; text?: string; url?: string } = {}): Promise<void> {
  const cache = await storage.open('nexdiary-geteilt')
  await cache.put(`/__geteilt/${id}/meta`, kept({ at, count: photos.length, title: words.title ?? '', text: words.text ?? '', url: words.url ?? '' }))
  for (const [index, photo] of photos.entries()) await cache.put(`/__geteilt/${id}/${index}`, kept(photo))
}
