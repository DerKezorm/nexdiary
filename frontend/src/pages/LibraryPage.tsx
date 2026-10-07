/**
 * "My photos": every photo of the signed-in person on one page, newest day first, grouped by month, a page at a time
 * (the small copies). Under each one it says where it is used (cover of a day, in a text, on a note) with a link to
 * that day, or that it is not used at all; a filter keeps only those, to find what is superfluous. A photo opens in the
 * big view, can be deleted there, and several can be chosen and deleted at once. The line at the top says how much
 * of the storage the photos take. The server answers about the own photos only.
 */
import { Check, ImageOff, Loader2, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { ApiError, photosApi, photoUrl, type LibraryPhoto, type PhotoStorage } from '../api/client'
import { useDeletePhotos } from '../components/PhotoDelete'
import { PhotoTile } from '../components/PhotoViews'
import { useLightbox, type ViewerPhoto } from '../components/Lightbox'
import { dayOfMoment, longDate, monthName } from '../lib/dates'
import { errorText } from '../lib/errors'
import { formatBytes } from '../lib/bytes'
import { useAuth } from '../state/auth'
import { Button, Segment } from './settings/ui'

type Filter = 'all' | 'unused'

/** "2026-10-07" in the time zone of the person: the day "Today" stands for. */
function todayIn(zone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone || undefined }).format(new Date())
  } catch {
    return new Intl.DateTimeFormat('en-CA').format(new Date())
  }
}

const isUsed = (photo: LibraryPhoto) => photo.uses.cover || photo.uses.text || photo.uses.notes.length > 0

export function LibraryPage() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const { confirmDelete } = useDeletePhotos()
  const { open } = useLightbox()
  const [filter, setFilter] = useState<Filter>('all')
  const [photos, setPhotos] = useState<LibraryPhoto[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [storage, setStorage] = useState<PhotoStorage | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  /** Which request is the current one: an answer to an older one (another filter) is dropped. */
  const round = useRef(0)
  const today = todayIn(me?.profile?.timezone)

  const loadPage = useCallback(
    async (kind: Filter, after: string) => {
      const mine = round.current
      setLoading(true)
      try {
        const page = await photosApi.library(after, kind === 'unused')
        if (mine !== round.current) return
        setPhotos((current) => {
          const known = new Set(current.map((photo) => photo.id))
          return [...current, ...page.photos.filter((photo) => !known.has(photo.id))]
        })
        setNext(page.next)
        setProblem(null)
      } catch (error) {
        if (mine === round.current) setProblem(error instanceof ApiError ? error.code : 'internal_error')
      } finally {
        if (mine === round.current) {
          setLoading(false)
          setLoaded(true)
        }
      }
    },
    [],
  )

  const refreshStorage = useCallback(() => {
    photosApi.storage().then(setStorage, () => undefined)
  }, [])

  useEffect(() => {
    round.current += 1
    setPhotos([])
    setNext(null)
    setLoaded(false)
    setChosen(new Set())
    void loadPage(filter, '')
  }, [filter, loadPage])

  useEffect(() => {
    refreshStorage()
  }, [refreshStorage])

  const groups = useMemo(() => {
    const out: { month: string; photos: LibraryPhoto[] }[] = []
    for (const photo of photos) {
      const month = photo.date.slice(0, 7)
      if (out.length === 0 || out[out.length - 1].month !== month) out.push({ month, photos: [] })
      out[out.length - 1].photos.push(photo)
    }
    return out
  }, [photos])

  const gone = (ids: string[]) => {
    const away = new Set(ids)
    setPhotos((current) => current.filter((photo) => !away.has(photo.id)))
    setChosen((current) => new Set([...current].filter((id) => !away.has(id))))
    refreshStorage()
  }

  const known = (photo: LibraryPhoto) => ({ cover: photo.uses.cover, text: photo.uses.text, notes: photo.uses.notes, date: photo.date })

  const view = (opener: HTMLElement, index: number) => {
    const list: ViewerPhoto[] = photos.map((photo) => ({
      id: photo.id,
      src: photoUrl(photo.id),
      alt: t('library.photoOf', { day: longDate(photo.date, i18n.language, true) }),
      onDelete: async () => {
        const result = await confirmDelete([photo.id], { [photo.id]: known(photo) })
        if (!result?.deleted.includes(photo.id)) return false
        gone([photo.id])
        return true
      },
    }))
    open(list, index, opener)
  }

  const toggle = (id: string) =>
    setChosen((current) => {
      const nextSet = new Set(current)
      if (!nextSet.delete(id)) nextSet.add(id)
      return nextSet
    })

  const deleteChosen = async () => {
    const ids = [...chosen]
    if (ids.length === 0) return
    const only = Object.fromEntries(photos.filter((photo) => chosen.has(photo.id)).map((photo) => [photo.id, known(photo)]))
    const result = await confirmDelete(ids, only)
    if (result) gone(result.deleted)
  }

  const day = (date: string) => dayOfMoment(`${date}T12:00:00Z`, i18n.language, 'UTC')
  const dayLong = (date: string) => longDate(date, i18n.language, true)

  const limit = storage?.limit ?? null
  const share = storage && limit ? Math.min(100, Math.round((storage.used / limit) * 100)) : null

  return (
    <div className="page space-y-6 pt-8 pb-28 lg:pb-12">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t('library.title')}</h1>
        <p className="mt-1 text-ink-2">{t('library.intro')}</p>
      </header>

      {storage && (
        <div className="card px-5 py-4" data-testid="storage">
          <p className="text-sm font-semibold">
            {limit !== null ? t('library.storageOf', { used: formatBytes(storage.used, i18n.language), limit: formatBytes(limit, i18n.language) }) : t('library.storage', { used: formatBytes(storage.used, i18n.language) })}
            <span className="font-normal text-muted"> · {t('library.count', { count: storage.count })}</span>
          </p>
          {share !== null && (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-sheet-2" role="img" aria-label={t('library.share', { percent: share })}>
              <div className="h-full rounded-full bg-accent" style={{ width: `${share}%` }} />
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segment
          value={filter}
          onChange={setFilter}
          label={t('library.filter')}
          options={[
            { value: 'all', label: t('library.all') },
            { value: 'unused', label: t('library.unused') },
          ]}
        />
        {photos.length > 0 && (
          <div className="flex items-center gap-2">
            {choosing && (
              <Button danger disabled={chosen.size === 0} onClick={() => void deleteChosen()}>
                <Trash2 size={15} aria-hidden /> {chosen.size === 0 ? t('library.delete') : t('library.deleteChosen', { count: chosen.size })}
              </Button>
            )}
            <Button
              onClick={() => {
                setChoosing(!choosing)
                setChosen(new Set())
              }}
            >
              {choosing ? t('common.done') : t('library.choose')}
            </Button>
          </div>
        )}
      </div>

      {problem && (
        <p role="alert" className="text-sm text-bad">
          {errorText(problem)}
        </p>
      )}

      {!loaded && !problem && <p className="text-sm text-muted">{t('library.loading')}</p>}
      {loaded && photos.length === 0 && !problem && (
        <p className="rounded-2xl border border-dashed border-line px-5 py-8 text-center text-muted" data-testid="library-empty">
          {filter === 'unused' ? t('library.noneUnused') : t('library.none')}
        </p>
      )}

      {groups.map((group) => (
        <section key={group.month} aria-label={monthName(`${group.month}-01`, i18n.language, true)}>
          <h2 className="mb-3 font-display text-xl font-semibold">{monthName(`${group.month}-01`, i18n.language, true)}</h2>
          <ul className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4">
            {group.photos.map((photo) => {
              const index = photos.indexOf(photo)
              const on = chosen.has(photo.id)
              const used = isUsed(photo)
              return (
                <li key={photo.id} className="min-w-0" data-photo={photo.id}>
                  <div className="relative">
                    <PhotoTile
                      src={photoUrl(photo.id, true)}
                      alt={t('library.photoOf', { day: dayLong(photo.date) })}
                      onOpen={(opener) => (choosing ? toggle(photo.id) : view(opener, index))}
                      className={`aspect-square w-full rounded-xl ${on ? 'ring-2 ring-accent ring-offset-2 ring-offset-paper' : ''}`}
                      imageClassName="h-full w-full"
                    />
                    {choosing && (
                      <span className={`pointer-events-none absolute top-1.5 left-1.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white ${on ? 'bg-accent text-accent-ink' : 'bg-black/30'}`} aria-hidden>
                        {on && <Check size={14} strokeWidth={3} />}
                      </span>
                    )}
                  </div>
                  <ul className="mt-1.5 space-y-0.5 text-xs leading-snug" data-uses>
                    {photo.uses.cover && (
                      <li>
                        <Link to={`/tag/${photo.date}`} className="font-semibold text-accent hover:underline">
                          {t('library.useCover', { day: day(photo.date) })}
                        </Link>
                      </li>
                    )}
                    {photo.uses.text && (
                      <li>
                        <Link to={`/tag/${photo.date}`} className="font-semibold text-accent hover:underline">
                          {t('library.useText', { day: day(photo.date) })}
                        </Link>
                      </li>
                    )}
                    {photo.uses.notes.map((note) => (
                      <li key={note.id}>
                        <Link to={note.date === today ? '/' : `/tag/${note.date}`} className="font-semibold text-accent hover:underline">
                          {t('library.useNote', { day: day(note.date) })}
                        </Link>
                      </li>
                    ))}
                    {!used && (
                      <>
                        <li className="flex items-center gap-1 text-muted" data-unused>
                          <ImageOff size={12} aria-hidden /> {t('library.notUsed')}
                        </li>
                        <li>
                          <Link to={`/tag/${photo.date}`} className="text-muted hover:underline">
                            {day(photo.date)}
                          </Link>
                        </li>
                      </>
                    )}
                  </ul>
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      {next !== null && (
        <div className="flex justify-center">
          <Button busy={loading} disabled={loading} onClick={() => void loadPage(filter, next)}>
            {loading ? <Loader2 size={15} className="animate-spin" aria-hidden /> : null} {t('library.more')}
          </Button>
        </div>
      )}
    </div>
  )
}
