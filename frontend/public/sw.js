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

/** Only a path of nexdiary itself, never another site. */
function ownPath(value, fallback) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : fallback
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
      icon: '/logo.svg',
      badge: '/logo.svg',
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
