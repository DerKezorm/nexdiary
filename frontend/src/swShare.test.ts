/**
 * The service worker (`public/sw.js`) and photos shared from another app: of all requests it takes the share target's
 * POST to /schnell of its own origin and nothing else, keeps at most ten photos with the words for half an hour at most,
 * and leads to the quick note with the id of the share. Run against a stand-in of its surroundings.
 */
import source from '../public/sw.js?raw'
import { FakeCacheStorage } from './test/fakeCaches'

const ORIGIN = 'https://diary.example.com'

type Handler = (event: unknown) => void

/** An answer as the worker makes one, without the platform's own (which takes no Blob of jsdom under Node 22). */
class FakeResponse {
  constructor(
    readonly body: unknown,
    readonly init: { headers?: Record<string, string> } = {},
  ) {}
  async json(): Promise<unknown> {
    return JSON.parse(String(this.body))
  }
  async blob(): Promise<Blob> {
    return this.body as Blob
  }
  static redirect(url: string, status: number) {
    return { redirect: url, status }
  }
}

class FakePattern {
  constructor(readonly init: Record<string, string>) {}
}

type Worker = { handlers: Record<string, Handler>; storage: FakeCacheStorage }

const FIRST = '11111111-1111-4111-8111-111111111111'

function worker(extra: Record<string, unknown> = {}): Worker {
  const handlers: Record<string, Handler> = {}
  const storage = new FakeCacheStorage(ORIGIN)
  const ids = [FIRST, '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
  const self = {
    addEventListener: (type: string, handler: Handler) => (handlers[type] = handler),
    skipWaiting() {},
    clients: { claim() {} },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 15)' },
    location: { origin: ORIGIN },
    caches: storage,
    crypto: { randomUUID: () => ids.shift() },
    ...extra,
  }
  new Function('self', 'URL', 'Response', source)(self, URL, FakeResponse)
  return { handlers, storage }
}

type Sent = { method: string; url: string; read: number; formData(): Promise<FormData> }

function request(method: string, url: string, form: FormData | (() => never) = new FormData()): Sent {
  const sent: Sent = {
    method,
    url,
    read: 0,
    async formData() {
      sent.read += 1
      return typeof form === 'function' ? form() : form
    },
  }
  return sent
}

type Answer = { redirect: string; status: number }

async function dispatch(work: Worker, sent: Sent): Promise<{ answered: boolean; answer?: Answer }> {
  let answer: Promise<Answer> | undefined
  work.handlers.fetch({ request: sent, respondWith: (value: Promise<Answer>) => (answer = value) })
  return answer ? { answered: true, answer: await answer } : { answered: false }
}

function photo(name: string, size = 64, type = 'image/jpeg'): File {
  return new File([new Uint8Array(size).fill(7)], name, { type })
}

function shared(count: number, words: Record<string, string> = {}): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(words)) form.append(key, value)
  for (let index = 0; index < count; index += 1) form.append('photos', photo(`${index}.jpg`, 64 + index))
  return form
}

async function metaOf(work: Worker, id: string): Promise<Record<string, unknown>> {
  const found = await (await work.storage.open('nexdiary-geteilt')).match(`/__geteilt/${id}/meta`)
  return (await found!.json()) as Record<string, unknown>
}

describe('the service worker and a share', () => {
  it.each([
    ['GET', ORIGIN + '/schnell'],
    ['GET', ORIGIN + '/'],
    ['POST', ORIGIN + '/api/notes'],
    ['PUT', ORIGIN + '/api/days/2026-10-10/draft'],
    ['POST', ORIGIN + '/api/photos?upload_id=x'],
    ['POST', ORIGIN + '/schnell/'],
    ['POST', ORIGIN + '/schnellnotiz'],
    ['POST', 'https://evil.example.org/schnell'],
    ['POST', 'https://diary.example.com:8443/schnell'],
  ])('leaves every other request alone: %s %s', async (method, url) => {
    const work = worker()
    const sent = request(method, url, shared(2))
    const { answered } = await dispatch(work, sent)
    expect(answered).toBe(false)
    expect(sent.read).toBe(0)
    expect(work.storage.addresses()).toEqual([])
  })

  it('keeps the photos and the words and leads to the quick note with the id', async () => {
    const work = worker()
    const before = Date.now()
    const { answer } = await dispatch(work, request('POST', ORIGIN + '/schnell', shared(3, { title: 'Kastanien', text: 'Schau mal', url: 'https://example.com/a' })))
    expect(answer).toEqual({ redirect: `${ORIGIN}/schnell?geteilt=${FIRST}`, status: 303 })
    const cache = await work.storage.open('nexdiary-geteilt')
    const base = `${ORIGIN}/__geteilt/${FIRST}/`
    expect([...cache.entries.keys()].sort()).toEqual([base + '0', base + '1', base + '2', base + 'meta'])
    const meta = await metaOf(work, FIRST)
    expect(meta).toMatchObject({ count: 3, title: 'Kastanien', text: 'Schau mal', url: 'https://example.com/a' })
    expect(meta.at as number).toBeGreaterThanOrEqual(before)
    for (const index of [0, 1, 2]) {
      const part = cache.entries.get(base + index) as unknown as FakeResponse
      expect(((await part.blob()) as File).size).toBe(64 + index)
      expect(part.init.headers).toEqual({ 'content-type': 'image/jpeg' })
    }
  })

  it('keeps a text without photos the same way, so that it never stands in an address', async () => {
    const work = worker()
    const { answer } = await dispatch(work, request('POST', ORIGIN + '/schnell', shared(0, { text: 'nur ein satz' })))
    expect(answer?.redirect).toBe(`${ORIGIN}/schnell?geteilt=${FIRST}`)
    expect(await metaOf(work, FIRST)).toMatchObject({ count: 0, text: 'nur ein satz' })
  })

  it('takes at most ten photos: eleven are not kept at all', async () => {
    const work = worker()
    expect((await dispatch(work, request('POST', ORIGIN + '/schnell', shared(10)))).answer?.redirect).toBe(`${ORIGIN}/schnell?geteilt=${FIRST}`)
    const eleven = await dispatch(work, request('POST', ORIGIN + '/schnell', shared(11, { text: 'zu viele' })))
    expect(eleven.answer).toEqual({ redirect: ORIGIN + '/schnell?geteilt=zuviele', status: 303 })
    expect(work.storage.addresses().filter((address) => !address.includes(FIRST))).toEqual([])
  })

  it('leaves out empty entries, entries that are no file, and words past the length of a note', async () => {
    const work = worker()
    const form = shared(1, { text: 'x'.repeat(6000) })
    form.append('photos', new File([], 'leer.jpg', { type: 'image/jpeg' }))
    form.append('photos', 'kein bild')
    await dispatch(work, request('POST', ORIGIN + '/schnell', form))
    const meta = await metaOf(work, FIRST)
    expect(meta.count).toBe(1)
    expect(meta.text).toHaveLength(5000)
  })

  it('says so and keeps nothing when the form cannot be read or the storage is full', async () => {
    const work = worker()
    const broken = await dispatch(
      work,
      request('POST', ORIGIN + '/schnell', () => {
        throw new TypeError('not a form')
      }),
    )
    expect(broken.answer).toEqual({ redirect: ORIGIN + '/schnell?geteilt=fehler', status: 303 })
    ;(await work.storage.open('nexdiary-geteilt')).failAfter = 2
    const full = await dispatch(work, request('POST', ORIGIN + '/schnell', shared(3)))
    expect(full.answer).toEqual({ redirect: ORIGIN + '/schnell?geteilt=fehler', status: 303 })
    expect(work.storage.addresses()).toEqual([])
  })

  it('clears away what waited longer than half an hour, and parts without their description', async () => {
    const work = worker()
    const cache = await work.storage.open('nexdiary-geteilt')
    const old = '/__geteilt/99999999-9999-4999-8999-999999999999/'
    const fresh = '/__geteilt/88888888-8888-4888-8888-888888888888/'
    await cache.put(old + 'meta', new FakeResponse(JSON.stringify({ at: Date.now() - 31 * 60 * 1000, count: 1 })))
    await cache.put(old + '0', new FakeResponse(photo('a.jpg')))
    await cache.put(fresh + 'meta', new FakeResponse(JSON.stringify({ at: Date.now() - 60 * 1000, count: 0 })))
    await cache.put('/__geteilt/77777777-7777-4777-8777-777777777777/0', new FakeResponse(photo('b.jpg')))
    await dispatch(work, request('POST', ORIGIN + '/schnell', shared(1)))
    const left = work.storage.addresses().map((address) => address.slice(ORIGIN.length))
    expect(left.sort()).toEqual([fresh + 'meta', `/__geteilt/${FIRST}/0`, `/__geteilt/${FIRST}/meta`].sort())
  })

  it('tells the browser to send everything but the share straight to the network', () => {
    const routes: unknown[] = []
    const waited: unknown[] = []
    const work = worker({ URLPattern: FakePattern })
    work.handlers.install({
      addRoutes: (given: unknown[]) => {
        routes.push(...given)
        return Promise.resolve()
      },
      waitUntil: (value: unknown) => waited.push(value),
    })
    expect(routes).toEqual([
      { condition: { requestMethod: 'POST', urlPattern: new FakePattern({ pathname: '/schnell' }) }, source: 'fetch-event' },
      { condition: { urlPattern: new FakePattern({}) }, source: 'network' },
    ])
    expect(waited).toHaveLength(1)
    // A browser that refuses the rules, or knows none: the worker still installs.
    const refusing = worker({ URLPattern: FakePattern })
    expect(() => refusing.handlers.install({ addRoutes: () => Promise.reject(new TypeError('no')), waitUntil: () => undefined })).not.toThrow()
    expect(() =>
      refusing.handlers.install({
        addRoutes: () => {
          throw new TypeError('no')
        },
        waitUntil: () => undefined,
      }),
    ).not.toThrow()
    expect(() => worker().handlers.install({ waitUntil: () => undefined })).not.toThrow()
  })
})
