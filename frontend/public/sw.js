// The service worker of nexdiary: Web Push, and photos shared into nexdiary from another app.
//
// It shows what the server sends (a reminder, a notice of a new sign-in) and opens nexdiary where a tap leads. Of all
// requests it takes exactly one kind: the POST of the share target to /schnell, which carries the shared photos. Those
// are kept for a short while in the browser's own storage, and the page picks them up and uploads them the ordinary
// way, with its session and its header. Every other request goes past it untouched: it keeps no pictures and no answers
// of the API, and it does not stand in the way of a draft sent while the page closes.

/** Where shared photos wait for the quick note, and for how long at most. */
const SHARE_CACHE = 'nexdiary-geteilt'
const SHARE_PREFIX = '/__geteilt/'
const SHARE_KEEP_MS = 30 * 60 * 1000
const SHARE_MAX = 10
const SHARE_TEXT_MAX = 5000

self.addEventListener('install', (event) => {
  self.skipWaiting()
  // Where the browser can be told so (Chrome's static routing), every request but the share goes straight to the
  // network without even waking this worker: a request sent while the page closes is not held up by it.
  if (typeof event.addRoutes === 'function' && typeof self.URLPattern === 'function') {
    try {
      const routes = event.addRoutes([
        { condition: { requestMethod: 'POST', urlPattern: new self.URLPattern({ pathname: '/schnell' }) }, source: 'fetch-event' },
        { condition: { urlPattern: new self.URLPattern({}) }, source: 'network' },
      ])
      event.waitUntil(Promise.resolve(routes).catch(() => undefined))
    } catch {
      // Not understood by this browser: the fetch handler below lets everything else past as well.
    }
  }
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/**
 * Only a path of nexdiary itself, never another site. A browser drops tabs and line breaks from an address before it
 * reads it ("/" tab "//evil.example.org" becomes "//evil.example.org"), so control characters and backslashes are
 * refused outright, and what is left must still be of this origin once the browser has read it.
 */
function ownPath(value, fallback) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(value)) return fallback
  try {
    const target = new URL(value, self.location.origin)
    return target.origin === self.location.origin ? target.pathname + target.search + target.hash : fallback
  } catch {
    return fallback
  }
}

function onPhone() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(self.navigator.userAgent)
}

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = typeof data.title === 'string' && data.title ? data.title.slice(0, 80) : 'nexdiary'
  const body = typeof data.body === 'string' ? data.body.slice(0, 600) : ''
  const phone = ownPath(data.url, '/')
  const desk = ownPath(data.desk, phone)
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // PNG, not SVG: Android and Windows draw no SVG in a notification. The badge is read as a mask, white on clear.
      icon: '/icon-192.png',
      badge: '/badge-96.png',
      tag: typeof data.tag === 'string' ? data.tag.slice(0, 40) : undefined,
      data: { url: onPhone() ? phone : desk },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = new URL(ownPath(event.notification.data && event.notification.data.url, '/'), self.location.origin)
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of open) {
        if (new URL(client.url).origin !== self.location.origin) continue
        try {
          await client.focus()
          await client.navigate(target.href)
          return
        } catch {
          // A window this worker does not control cannot be led elsewhere: a new one instead.
          break
        }
      }
      await self.clients.openWindow(target.href)
    })(),
  )
})

/** The one request this worker takes: the share target's POST to /schnell of this origin. */
function isShare(request) {
  if (request.method !== 'POST') return false
  try {
    const url = new URL(request.url)
    return url.origin === self.location.origin && url.pathname === '/schnell'
  } catch {
    return false
  }
}

function shareKey(id, part) {
  return new URL(SHARE_PREFIX + id + '/' + part, self.location.origin).href
}

function seeOther(search) {
  return Response.redirect(new URL('/schnell' + search, self.location.origin).href, 303)
}

/** Shares older than the time they may wait are gone, and so are parts left without their description. */
async function sweepShares(cache, now) {
  const keys = await cache.keys()
  const fresh = new Set()
  for (const key of keys) {
    const path = new URL(key.url).pathname
    if (!path.startsWith(SHARE_PREFIX) || !path.endsWith('/meta')) continue
    const found = await cache.match(key)
    let at = 0
    try {
      at = Number((await found.json()).at) || 0
    } catch {
      at = 0
    }
    if (now - at >= 0 && now - at < SHARE_KEEP_MS) fresh.add(path.split('/')[2])
  }
  for (const key of keys) {
    const path = new URL(key.url).pathname
    if (path.startsWith(SHARE_PREFIX) && !fresh.has(path.split('/')[2])) await cache.delete(key)
  }
}

function shortText(value) {
  return typeof value === 'string' ? value.trim().slice(0, SHARE_TEXT_MAX) : ''
}

/**
 * Takes what another app shared: at most ten photos plus title, text and link, kept until the quick note picks them up
 * (or for half an hour at most), then leads there with the id of the share. More than ten photos are not kept at all.
 */
async function takeShare(request, now) {
  let form
  try {
    form = await request.formData()
  } catch {
    return seeOther('?geteilt=fehler')
  }
  const photos = form.getAll('photos').filter((value) => typeof value === 'object' && value !== null && typeof value.size === 'number' && value.size > 0)
  if (photos.length > SHARE_MAX) return seeOther('?geteilt=zuviele')
  const id = self.crypto.randomUUID()
  let cache
  try {
    cache = await self.caches.open(SHARE_CACHE)
    await sweepShares(cache, now)
    const meta = { at: now, count: photos.length, title: shortText(form.get('title')), text: shortText(form.get('text')), url: shortText(form.get('url')) }
    await cache.put(shareKey(id, 'meta'), new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }))
    for (let index = 0; index < photos.length; index += 1) {
      const photo = photos[index]
      await cache.put(shareKey(id, String(index)), new Response(photo, { headers: { 'content-type': photo.type || 'application/octet-stream' } }))
    }
  } catch {
    // The storage is full or not there: nothing half kept stays behind, and the page says to share again.
    if (cache) {
      for (const key of await cache.keys().catch(() => [])) {
        if (new URL(key.url).pathname.startsWith(SHARE_PREFIX + id + '/')) await cache.delete(key).catch(() => undefined)
      }
    }
    return seeOther('?geteilt=fehler')
  }
  return seeOther('?geteilt=' + id)
}

self.addEventListener('fetch', (event) => {
  if (!isShare(event.request)) return
  event.respondWith(takeShare(event.request, Date.now()))
})
