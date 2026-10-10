/**
 * Photos shared into nexdiary from another app, as the service worker (`public/sw.js`) keeps them: in the browser's
 * Cache Storage, under an id that comes to the quick note in its address (`/schnell?geteilt=<id>`). The quick note takes
 * a share out once and at once: read and removed in one go, so nothing stays behind and nothing becomes two notes. What
 * nobody picked up is gone after half an hour, and all of it when somebody signs out.
 */
import { joinShared } from './shared'

const CACHE = 'nexdiary-geteilt'
const PREFIX = '/__geteilt/'
/** As in `sw.js`. */
export const SHARE_KEEP_MS = 30 * 60 * 1000
export const SHARE_MAX = 10
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** What a share brought: the text (title, text, link joined) and the photos, in the order they were shared. */
export type SharedItem = { text: string; photos: Blob[] }

/** What the address of the quick note says: a share to pick up, a share the worker could not keep, or nothing. */
export type ShareSignal = { id: string } | { problem: 'share_too_many' | 'share_lost' } | null

export function shareSignal(search: string): ShareSignal {
  const value = new URLSearchParams(search).get('geteilt')
  if (value === null) return null
  if (value === 'zuviele') return { problem: 'share_too_many' }
  if (ID.test(value)) return { id: value }
  // "verloren" (the server got the share, no worker was there), "fehler" (the storage refused), or anything else.
  return { problem: 'share_lost' }
}

function storage(): CacheStorage | null {
  return typeof caches === 'undefined' ? null : caches
}

function idOf(url: string): string | null {
  const path = new URL(url, window.location.origin).pathname
  return path.startsWith(PREFIX) ? path.slice(PREFIX.length).split('/')[0] : null
}

/** Removes every part of one share, or of all shares. */
export async function dropShared(id?: string): Promise<void> {
  const store = storage()
  if (!store) return
  try {
    const cache = await store.open(CACHE)
    for (const key of await cache.keys()) {
      const owner = idOf(key.url)
      if (owner !== null && (id === undefined || owner === id)) await cache.delete(key)
    }
  } catch {
    // No storage to clear.
  }
}

/** Signing out: whatever waits goes, so that the next person to sign in on this device does not get it. */
export async function dropAllShared(): Promise<void> {
  const store = storage()
  if (!store) return
  try {
    await store.delete(CACHE)
  } catch {
    // Nothing kept.
  }
}

/** What waited longer than it may: gone. Run when the app starts; the worker does the same with each new share. */
export async function sweepShared(now = Date.now()): Promise<void> {
  const store = storage()
  if (!store) return
  try {
    if (!(await store.has(CACHE))) return
    const cache = await store.open(CACHE)
    const fresh = new Set<string>()
    const keys = await cache.keys()
    for (const key of keys) {
      if (!new URL(key.url).pathname.endsWith('/meta')) continue
      const at = Number(((await (await cache.match(key))?.json().catch(() => null)) as { at?: unknown } | null)?.at) || 0
      if (now - at >= 0 && now - at < SHARE_KEEP_MS) fresh.add(idOf(key.url) ?? '')
    }
    for (const key of keys) {
      const owner = idOf(key.url)
      if (owner !== null && !fresh.has(owner)) await cache.delete(key)
    }
  } catch {
    // No storage to clear.
  }
}

/**
 * The id of the newest share still waiting, or null. For a sign-in that did not come back to the quick note's address
 * (the provider of a single sign-on knows nothing of it): the app leads there itself.
 */
export async function waitingShare(now = Date.now()): Promise<string | null> {
  const store = storage()
  if (!store) return null
  try {
    if (!(await store.has(CACHE))) return null
    const cache = await store.open(CACHE)
    let newest: { id: string; at: number } | null = null
    for (const key of await cache.keys()) {
      const id = idOf(key.url)
      if (id === null || !ID.test(id) || !new URL(key.url).pathname.endsWith('/meta')) continue
      const at = Number(((await (await cache.match(key))?.json().catch(() => null)) as { at?: unknown } | null)?.at) || 0
      if (now - at >= 0 && now - at < SHARE_KEEP_MS && (newest === null || at > newest.at)) newest = { id, at }
    }
    return newest?.id ?? null
  } catch {
    return null
  }
}

/**
 * Takes one share out of the storage: what it brought, or null when it is not there (any more), too old, or broken.
 * Removed either way before this returns.
 */
export async function takeShared(id: string, now = Date.now()): Promise<SharedItem | null> {
  const store = storage()
  if (!store || !ID.test(id)) return null
  try {
    const cache = await store.open(CACHE)
    const meta = await cache.match(`${PREFIX}${id}/meta`)
    if (!meta) return null
    try {
      const about = (await meta.json()) as { at?: unknown; count?: unknown; title?: unknown; text?: unknown; url?: unknown }
      const at = Number(about.at) || 0
      const count = Number(about.count)
      if (now - at < 0 || now - at >= SHARE_KEEP_MS || !Number.isInteger(count) || count < 0) return null
      const photos: Blob[] = []
      for (let index = 0; index < Math.min(count, SHARE_MAX + 1); index += 1) {
        const part = await cache.match(`${PREFIX}${id}/${index}`)
        if (!part) return null
        photos.push(await part.blob())
      }
      return { text: joinShared(about), photos }
    } finally {
      await dropShared(id)
    }
  } catch {
    return null
  }
}

/**
 * When the app starts: the service worker is registered (sharing photos into nexdiary needs it, not only Web Push), and
 * what waited too long is cleared away.
 */
export function startSharing(): void {
  if (window.isSecureContext && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined)
  void sweepShared()
}
