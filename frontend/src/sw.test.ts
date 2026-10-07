/**
 * The service worker itself (`public/sw.js`), run against a stand-in of its surroundings: a push shows as a
 * notification, and a tap opens a path of nexdiary and never another site, whatever the message says. Browsers drop
 * tabs and line breaks from an address before they read it; those tricks are among the cases.
 */
import source from '../public/sw.js?raw'

const ORIGIN = 'https://diary.example.com'

type Handler = (event: unknown) => void

async function tap(url: unknown, agent = 'Mozilla/5.0 (iPhone)'): Promise<{ data: { url: string }; opened: string[] }> {
  const handlers: Record<string, Handler> = {}
  const shown: { title: string; options: { data: { url: string } } }[] = []
  const opened: string[] = []
  const self = {
    addEventListener: (type: string, handler: Handler) => (handlers[type] = handler),
    skipWaiting() {},
    clients: { claim() {}, matchAll: async () => [], openWindow: async (address: string) => opened.push(address) },
    registration: { showNotification: async (title: string, options: { data: { url: string } }) => shown.push({ title, options }) },
    navigator: { userAgent: agent },
    location: { origin: ORIGIN },
  }
  new Function('self', 'URL', source)(self, URL)
  let pending: Promise<unknown> = Promise.resolve()
  handlers.push({ data: { json: () => ({ title: 'nexdiary', body: 'Wie war dein Tag?', url, desk: url, tag: 'x' }) }, waitUntil: (work: Promise<unknown>) => (pending = work) })
  await pending
  handlers.notificationclick({ notification: { data: shown[0].options.data, close() {} }, waitUntil: (work: Promise<unknown>) => (pending = work) })
  await pending
  return { data: shown[0].options.data, opened }
}

describe('the service worker', () => {
  it('opens a path of nexdiary where a tap leads', async () => {
    const { opened } = await tap('/schnell?x=1')
    expect(opened).toEqual([ORIGIN + '/schnell?x=1'])
  })

  it.each([
    'https://evil.example.org/x',
    '//evil.example.org',
    '/\t/evil.example.org/x',
    '/\n/evil.example.org',
    '/\r/evil.example.org',
    '/\\evil.example.org',
    'javascript:alert(1)',
    '/\u007f/evil.example.org',
    42,
  ])('never leads elsewhere: %j', async (url) => {
    const { data, opened } = await tap(url)
    expect(data.url).toBe('/')
    expect(opened).toEqual([ORIGIN + '/'])
  })
})
