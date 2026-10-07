/**
 * "Aus Immich wählen": any photo of the own Immich, not only those of a day. It opens on the whole collection as a
 * timeline (newest first, grouped by month, more as one scrolls); a date or a month to jump to, the albums (when the key
 * may read them) and a search are helps on top of it, never a limit. The entry's own day is only a mark to jump to.
 * Choosing a photo copies it to the day being written (`onPick`); the small pictures come through nexdiary.
 */
import { ChevronLeft, ChevronRight, ImageOff, Images, Loader2, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, immichApi, immichThumbUrl, type ImmichAlbum, type ImmichAlbums, type ImmichEntry, type ImmichPage } from '../api/client'
import { addDays } from '../lib/dates'
import { errorText } from '../lib/errors'
import { useAuth } from '../state/auth'
import { Dialog } from './Dialog'

type Way = 'all' | 'albums' | 'search'
type Problem = { code: string; values: Record<string, unknown> }

function problemOf(error: unknown): Problem {
  return error instanceof ApiError ? { code: error.code, values: error.values } : { code: 'internal_error', values: {} }
}

/** Pages of photos, one after the other: the first on its own when `key` changes, the rest with `more`. */
function usePages(load: (page: number) => Promise<ImmichPage>, key: string | null) {
  const [items, setItems] = useState<ImmichEntry[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [started, setStarted] = useState(false)
  const generation = useRef(0)
  const loader = useRef(load)
  useEffect(() => {
    loader.current = load
  })
  const busyNow = useRef(false)

  const fetchPage = useCallback((page: number, mine: number) => {
    busyNow.current = true
    setBusy(true)
    loader.current(page).then(
      (found) => {
        if (mine !== generation.current) return
        setItems((current) => {
          const seen = new Set(current.map((entry) => entry.id))
          return [...current, ...found.photos.filter((entry) => !seen.has(entry.id))]
        })
        setNext(found.next)
        setProblem(null)
        busyNow.current = false
        setBusy(false)
      },
      (error) => {
        if (mine !== generation.current) return
        setProblem(problemOf(error))
        busyNow.current = false
        setBusy(false)
      },
    )
  }, [])

  useEffect(() => {
    generation.current += 1
    setItems([])
    setNext(null)
    setProblem(null)
    busyNow.current = false
    if (key === null) {
      setStarted(false)
      setBusy(false)
      return
    }
    setStarted(true)
    fetchPage(1, generation.current)
  }, [key, fetchPage])

  const more = useCallback(() => {
    if (busyNow.current || next === null) return
    fetchPage(next, generation.current)
  }, [next, fetchPage])
  return { items, next, busy, problem, more, started }
}

/** The photos as small tiles under the name of their month; the last tile line asks for more once it is in view. */
function Tiles({
  pages,
  zone,
  taking,
  onPick,
  empty,
}: {
  pages: ReturnType<typeof usePages>
  zone: string | undefined
  taking: string | null
  onPick: (entry: ImmichEntry) => void
  empty: string
}) {
  const { t, i18n } = useTranslation()
  const sentinel = useRef<HTMLDivElement>(null)
  const { more } = pages
  useEffect(() => {
    const element = sentinel.current
    if (!element || typeof IntersectionObserver === 'undefined') return
    const watcher = new IntersectionObserver((seen) => seen.some((entry) => entry.isIntersecting) && more(), { rootMargin: '400px' })
    watcher.observe(element)
    return () => watcher.disconnect()
  }, [more, pages.items.length, pages.next])
  const month = useMemo(() => {
    const format = (stamp: string, options: Intl.DateTimeFormatOptions) => {
      try {
        return new Intl.DateTimeFormat(i18n.language, { ...options, timeZone: zone || undefined }).format(new Date(stamp))
      } catch {
        return new Intl.DateTimeFormat(i18n.language, options).format(new Date(stamp))
      }
    }
    return {
      key: (stamp: string) => format(stamp, { year: 'numeric', month: '2-digit' }),
      title: (stamp: string) => format(stamp, { year: 'numeric', month: 'long' }),
      label: (stamp: string) => format(stamp, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    }
  }, [i18n.language, zone])
  const groups: { key: string; title: string; entries: ImmichEntry[] }[] = []
  for (const entry of pages.items) {
    const key = month.key(entry.taken_at)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.entries.push(entry)
    else groups.push({ key, title: month.title(entry.taken_at), entries: [entry] })
  }
  return (
    <div data-immich-tiles>
      {groups.map((group) => (
        <section key={group.key} className="mb-5">
          <h3 className="sticky top-0 z-[1] -mx-1 mb-2 bg-sheet/95 px-1 py-1 text-xs font-bold tracking-wide text-muted uppercase backdrop-blur">{group.title}</h3>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {group.entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                disabled={taking !== null}
                onClick={() => onPick(entry)}
                aria-label={`${t('immichPicker.take')} ${month.label(entry.taken_at)}`}
                title={month.label(entry.taken_at)}
                className="relative overflow-hidden rounded-xl transition hover:-translate-y-0.5 disabled:opacity-60"
              >
                <img src={immichThumbUrl(entry.id)} alt="" className="aspect-square w-full bg-sheet-2 object-cover" draggable={false} />
                {taking === entry.id && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white">
                    <Loader2 size={20} className="animate-spin" aria-hidden />
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
      ))}
      {pages.started && !pages.busy && pages.items.length === 0 && !pages.problem && (
        <p className="py-10 text-center text-sm text-muted">
          <ImageOff size={18} className="mx-auto mb-1" aria-hidden /> {empty}
        </p>
      )}
      {pages.problem && (
        <p role="alert" className="mb-3 rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {errorText(pages.problem.code, pages.problem.values)}
        </p>
      )}
      <div ref={sentinel} className="flex min-h-10 items-center justify-center">
        {pages.busy ? (
          <Loader2 size={18} className="animate-spin text-muted" aria-label={t('immichPicker.loading')} />
        ) : (
          pages.next !== null && (
            <button type="button" onClick={pages.more} className="rounded-full px-4 py-1.5 text-sm font-semibold text-accent hover:bg-accent-soft">
              {t('immichPicker.more')}
            </button>
          )
        )}
      </div>
    </div>
  )
}

/** The kinds of dates the jump takes: a day `YYYY-MM-DD`, a month `YYYY-MM`. */
const DAY = /^\d{4}-\d{2}-\d{2}$/
const MONTH = /^\d{4}-\d{2}$/

export function ImmichPicker({
  date,
  onClose,
  onPick,
  title,
}: {
  /** The day being written: the mark "to this day" jumps to. */
  date: string
  onClose: () => void
  /** Copies the photo to the day. Done, the dialog closes; thrown (an `ApiError`), it stays and says why. */
  onPick: (entry: ImmichEntry) => Promise<void>
  title?: string
}) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const zone = me?.profile?.timezone
  const [way, setWay] = useState<Way>('all')
  const [until, setUntil] = useState('')
  const [jump, setJump] = useState(date)
  const [albums, setAlbums] = useState<ImmichAlbums | null>(null)
  const [album, setAlbum] = useState<ImmichAlbum | null>(null)
  const [typed, setTyped] = useState('')
  const [word, setWord] = useState('')
  const [taking, setTaking] = useState<string | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [mode, setMode] = useState<'smart' | 'metadata' | null>(null)

  const timeline = usePages((page) => immichApi.timeline(page, until), way === 'all' ? until || 'newest' : null)
  const inAlbum = usePages((page) => immichApi.albumPhotos(album!.id, page), way === 'albums' && album ? album.id : null)
  const found = usePages(
    async (page) => {
      const result = await immichApi.search(word, page)
      setMode(result.mode)
      return result
    },
    way === 'search' && word ? word : null,
  )

  // Whether the albums can be read at all, asked once: without the right the tab is left out, with a word about it.
  useEffect(() => {
    let alive = true
    immichApi.albums().then(
      (found) => alive && setAlbums(found),
      () => alive && setAlbums({ available: false, albums: [] }),
    )
    return () => {
      alive = false
    }
  }, [])

  const choose = async (entry: ImmichEntry) => {
    if (taking) return
    setTaking(entry.id)
    setProblem(null)
    try {
      await onPick(entry)
      onClose()
    } catch (error) {
      setProblem(problemOf(error))
    } finally {
      setTaking(null)
    }
  }

  const jumpTo = (value: string) => {
    if (!DAY.test(value) && !MONTH.test(value)) return
    setJump(DAY.test(value) ? value : `${value}-01`)
    setUntil(value)
  }

  const tab = (value: Way, label: string, icon: ReactNode) => (
    <button
      key={value}
      type="button"
      role="tab"
      aria-selected={way === value}
      onClick={() => {
        setWay(value)
        setProblem(null)
      }}
      className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold transition ${way === value ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-sheet-2'}`}
    >
      {icon} {label}
    </button>
  )

  return (
    <Dialog title={title ?? t('immichPicker.title')} onClose={onClose} wide>
      <p className="-mt-2 mb-4 text-sm text-ink-2">{t('immichPicker.intro')}</p>
      <div role="tablist" aria-label={t('immichPicker.ways')} className="mb-3 flex flex-wrap gap-1.5">
        {tab('all', t('immichPicker.all'), <Images size={15} aria-hidden />)}
        {albums?.available && tab('albums', t('immichPicker.albums'), <Images size={15} aria-hidden />)}
        {tab('search', t('immichPicker.search'), <Search size={15} aria-hidden />)}
      </div>
      {problem && (
        <p role="alert" className="mb-3 rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {errorText(problem.code, problem.values)}
        </p>
      )}

      {way === 'all' && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2" data-immich-jump>
            <button type="button" aria-label={t('immichPicker.dayBefore')} title={t('immichPicker.dayBefore')} onClick={() => jumpTo(addDays(DAY.test(jump) ? jump : date, -1))} className="rounded-full p-2 text-ink-2 hover:bg-sheet-2">
              <ChevronLeft size={16} />
            </button>
            <input
              type="date"
              value={jump}
              max="2200-12-31"
              aria-label={t('immichPicker.jumpDay')}
              onChange={(event) => event.target.value && jumpTo(event.target.value)}
              className="h-9 rounded-full border border-line bg-paper px-3 text-sm text-ink focus:border-accent focus:outline-none"
            />
            <button type="button" aria-label={t('immichPicker.dayAfter')} title={t('immichPicker.dayAfter')} onClick={() => jumpTo(addDays(DAY.test(jump) ? jump : date, 1))} className="rounded-full p-2 text-ink-2 hover:bg-sheet-2">
              <ChevronRight size={16} />
            </button>
            <input
              type="month"
              value={MONTH.test(until) ? until : ''}
              aria-label={t('immichPicker.jumpMonth')}
              onChange={(event) => event.target.value && jumpTo(event.target.value)}
              className="h-9 rounded-full border border-line bg-paper px-3 text-sm text-ink focus:border-accent focus:outline-none"
            />
            <button type="button" onClick={() => jumpTo(date)} className="h-9 rounded-full bg-sheet-2 px-3.5 text-sm font-semibold text-ink-2 hover:bg-accent-soft hover:text-accent">
              {t('immichPicker.thisDay')}
            </button>
            {until && (
              <button
                type="button"
                onClick={() => {
                  setUntil('')
                  setJump(date)
                }}
                className="h-9 rounded-full px-3.5 text-sm font-semibold text-accent hover:bg-accent-soft"
              >
                {t('immichPicker.newest')}
              </button>
            )}
          </div>
          <Tiles pages={timeline} zone={zone} taking={taking} onPick={(entry) => void choose(entry)} empty={t('immichPicker.nothing')} />
        </>
      )}

      {way === 'albums' && (
        <>
          {!album && albums?.available && (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-immich-albums>
              {albums.albums.map((entry) => (
                <li key={entry.id}>
                  <button type="button" onClick={() => setAlbum(entry)} className="w-full overflow-hidden rounded-xl border border-line text-left transition hover:-translate-y-0.5 hover:border-accent">
                    {entry.cover ? (
                      <img src={immichThumbUrl(entry.cover)} alt="" className="aspect-[4/3] w-full bg-sheet-2 object-cover" draggable={false} />
                    ) : (
                      <span className="flex aspect-[4/3] w-full items-center justify-center bg-sheet-2 text-muted">
                        <Images size={22} aria-hidden />
                      </span>
                    )}
                    <span className="block px-3 py-2">
                      <span className="block truncate text-sm font-semibold">{entry.name || t('immichPicker.unnamed')}</span>
                      <span className="block text-xs text-muted">{t('immichPicker.albumCount', { count: entry.count })}</span>
                    </span>
                  </button>
                </li>
              ))}
              {albums.albums.length === 0 && <li className="col-span-full py-8 text-center text-sm text-muted">{t('immichPicker.noAlbums')}</li>}
            </ul>
          )}
          {album && (
            <>
              <div className="mb-3 flex items-center gap-2">
                <button type="button" onClick={() => setAlbum(null)} className="inline-flex h-9 items-center gap-1 rounded-full px-3 text-sm font-semibold text-ink-2 hover:bg-sheet-2">
                  <ChevronLeft size={15} aria-hidden /> {t('immichPicker.allAlbums')}
                </button>
                <span className="truncate font-semibold">{album.name || t('immichPicker.unnamed')}</span>
              </div>
              <Tiles pages={inAlbum} zone={zone} taking={taking} onPick={(entry) => void choose(entry)} empty={t('immichPicker.albumEmpty')} />
            </>
          )}
        </>
      )}

      {way === 'search' && (
        <>
          <form
            className="mb-3 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setMode(null)
              setWord(typed.trim())
            }}
          >
            <input
              value={typed}
              maxLength={100}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={t('immichPicker.searchPlaceholder')}
              aria-label={t('immichPicker.searchLabel')}
              className="h-10 min-w-0 flex-1 rounded-full border border-line bg-paper px-4 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <button type="submit" disabled={!typed.trim()} className="inline-flex h-10 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink disabled:opacity-50">
              <Search size={15} aria-hidden /> {t('immichPicker.searchDo')}
            </button>
          </form>
          {mode && <p className="mb-3 text-xs text-muted">{mode === 'smart' ? t('immichPicker.smart') : t('immichPicker.metadata')}</p>}
          {word ? (
            <Tiles pages={found} zone={zone} taking={taking} onPick={(entry) => void choose(entry)} empty={t('immichPicker.searchNothing')} />
          ) : (
            <p className="py-10 text-center text-sm text-muted">{t('immichPicker.searchHint')}</p>
          )}
        </>
      )}

      {albums && !albums.available && <p className="mt-4 text-xs text-muted">{t('immichPicker.noAlbumRight')}</p>}
    </Dialog>
  )
}
