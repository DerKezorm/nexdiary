// The service worker of nexdiary: Web Push and nothing else.
//
// It shows what the server sends (a reminder, a notice of a new sign-in) and opens nexdiary where a tap leads. It has
// no fetch handler on purpose: it never stands between the page and the server, so it keeps nothing (no pictures, no
// answers of the API) and swallows nothing (a draft sent while the page closes goes straight out). Sharing into
// nexdiary works without it: the manifest sends shared text to the quick note by address.

self.addEventListener('install', () => {
  self.skipWaiting()
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
