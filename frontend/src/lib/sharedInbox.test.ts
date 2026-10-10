/**
 * The page's side of shared photos: the address says what to pick up, a share is taken out once (read and removed in
 * one go), what waited longer than half an hour is gone, and signing out leaves nothing behind.
 */
import { FakeCacheStorage, keepShare, kept } from '../test/fakeCaches'
import { dropAllShared, shareSignal, sweepShared, takeShared, waitingShare } from './sharedInbox'

const ID = 'a1b2c3d4-0000-4000-8000-000000000001'
const OTHER = 'a1b2c3d4-0000-4000-8000-000000000002'
const NOW = 1_800_000_000_000
const MINUTE = 60 * 1000

let storage: FakeCacheStorage

beforeEach(() => {
  storage = new FakeCacheStorage(window.location.origin)
  vi.stubGlobal('caches', storage)
})

afterEach(() => vi.unstubAllGlobals())

function picture(size: number): Blob {
  return new Blob([new Uint8Array(size)], { type: 'image/jpeg' })
}

describe('the address of the quick note', () => {
  it('names a share to pick up, or what went wrong before', () => {
    expect(shareSignal(`?geteilt=${ID}`)).toEqual({ id: ID })
    expect(shareSignal('?geteilt=zuviele')).toEqual({ problem: 'share_too_many' })
    expect(shareSignal('?geteilt=verloren')).toEqual({ problem: 'share_lost' })
    expect(shareSignal('?geteilt=fehler')).toEqual({ problem: 'share_lost' })
    expect(shareSignal('?geteilt=../../api')).toEqual({ problem: 'share_lost' })
    expect(shareSignal('?text=hallo')).toBeNull()
    expect(shareSignal('')).toBeNull()
  })
})

describe('taking a share', () => {
  it('gives the photos in their order with the words joined, and removes it at once', async () => {
    await keepShare(storage, ID, NOW - MINUTE, [picture(3), picture(5)], { title: 'Kastanien', text: 'Schau mal', url: 'https://example.com/a' })
    await keepShare(storage, OTHER, NOW - MINUTE, [picture(7)])
    const item = await takeShared(ID, NOW)
    expect(item?.text).toBe('Kastanien\nSchau mal\nhttps://example.com/a')
    expect(item?.photos.map((photo) => photo.size)).toEqual([3, 5])
    expect(storage.addresses().filter((address) => address.includes(ID))).toEqual([])
    // Another share stays where it is; this one is not there a second time.
    expect(storage.addresses().filter((address) => address.includes(OTHER))).toHaveLength(2)
    expect(await takeShared(ID, NOW)).toBeNull()
  })

  it('finds nothing too old, broken or with a part missing, and removes it all the same', async () => {
    await keepShare(storage, ID, NOW - 31 * MINUTE, [picture(3)])
    expect(await takeShared(ID, NOW)).toBeNull()
    expect(storage.addresses()).toEqual([])
    await keepShare(storage, OTHER, NOW - MINUTE, [picture(3), picture(4)])
    await (await storage.open('nexdiary-geteilt')).delete(`/__geteilt/${OTHER}/1`)
    expect(await takeShared(OTHER, NOW)).toBeNull()
    expect(storage.addresses()).toEqual([])
    await (await storage.open('nexdiary-geteilt')).put(`/__geteilt/${ID}/meta`, kept({ at: NOW, count: 'viele' }))
    expect(await takeShared(ID, NOW)).toBeNull()
    expect(storage.addresses()).toEqual([])
  })

  it('reads at most one photo past the limit, enough for the page to refuse the share', async () => {
    await keepShare(storage, ID, NOW, Array.from({ length: 14 }, (_, index) => picture(index + 1)))
    expect((await takeShared(ID, NOW))?.photos).toHaveLength(11)
    expect(storage.addresses()).toEqual([])
  })

  it('takes nothing for an id of another shape', async () => {
    expect(await takeShared('../meta', NOW)).toBeNull()
  })

  it('is nothing at all in a browser without the storage', async () => {
    vi.stubGlobal('caches', undefined)
    expect(await takeShared(ID, NOW)).toBeNull()
    expect(await waitingShare(NOW)).toBeNull()
    await expect(sweepShared(NOW)).resolves.toBeUndefined()
    await expect(dropAllShared()).resolves.toBeUndefined()
  })
})

describe('what waits', () => {
  it('names the newest share still waiting, for a sign-in that came back without the address', async () => {
    expect(await waitingShare(NOW)).toBeNull()
    await keepShare(storage, ID, NOW - 5 * MINUTE, [picture(3)])
    await keepShare(storage, OTHER, NOW - 2 * MINUTE, [picture(3)])
    await keepShare(storage, 'a1b2c3d4-0000-4000-8000-000000000003', NOW - 40 * MINUTE, [picture(3)])
    expect(await waitingShare(NOW)).toBe(OTHER)
    expect(await waitingShare(NOW + 29 * MINUTE)).toBeNull()
  })

  it('is cleared away after half an hour, and parts without their description with it', async () => {
    await keepShare(storage, ID, NOW - 31 * MINUTE, [picture(3)])
    await keepShare(storage, OTHER, NOW - 29 * MINUTE, [picture(3)])
    await (await storage.open('nexdiary-geteilt')).put('/__geteilt/a1b2c3d4-0000-4000-8000-000000000009/0', kept(picture(1)))
    await sweepShared(NOW)
    expect(storage.addresses().map((address) => new URL(address).pathname).sort()).toEqual([`/__geteilt/${OTHER}/0`, `/__geteilt/${OTHER}/meta`])
  })

  it('is all gone when somebody signs out', async () => {
    await keepShare(storage, ID, NOW, [picture(3)])
    await dropAllShared()
    expect(storage.addresses()).toEqual([])
  })
})
