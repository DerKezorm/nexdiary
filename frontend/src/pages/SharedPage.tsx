/**
 * Shared, as the mock's `SharedPage.tsx`: the days others in the family gave to me, and the ones I gave. A shared day
 * is read only; the one who shared it can take it back at any time, and then it is gone here too. Values and notes
 * show only when the day was shared with them: the server sends nothing else.
 */
import { ArrowLeft, Heart, Lock, Share2, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { ApiError, sharedPhotoUrl, sharingApi, type SharedByMe, type SharedDay, type SharedItem } from '../api/client'
import { Avatar } from '../components/Avatar'
import { useLightbox } from '../components/Lightbox'
import { Markdown } from '../components/Markdown'
import { PhotoFigure, PhotoTile } from '../components/PhotoViews'
import { CoverImage } from '../covers/Cover'
import { longDate, timeOf } from '../lib/dates'
import { errorText } from '../lib/errors'
import { nameOf } from '../lib/people'
import { useAuth } from '../state/auth'
import { useShared } from '../state/shared'
import { TabRow } from './settings/ui'

type Tab = 'mit-mir' | 'von-mir'

export function SharedPage() {
  const { t, i18n } = useTranslation()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  const tab: Tab = params.get('tab') === 'von-mir' ? 'von-mir' : 'mit-mir'
  const [withMe, setWithMe] = useState<SharedItem[] | null>(null)
  const [byMe, setByMe] = useState<SharedByMe[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const { refresh } = useShared()

  const load = useCallback(() => {
    sharingApi.withMe().then(setWithMe, (error) => setProblem(error instanceof ApiError ? error.code : 'internal_error'))
    sharingApi.byMe().then(setByMe, (error) => setProblem(error instanceof ApiError ? error.code : 'internal_error'))
  }, [])
  useEffect(() => load(), [load])

  const unseen = (withMe ?? []).filter((item) => item.new).length

  const stop = async (item: SharedByMe) => {
    try {
      await sharingApi.stop(item.date)
      setByMe((list) => (list ?? []).filter((other) => other.date !== item.date))
      navigate(location.pathname + location.search, { replace: true, state: { notice: t('shared.stopped', { title: item.title || longDate(item.date, i18n.language, true) }) } })
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
    refresh()
  }

  return (
    <div className="page space-y-5 pt-8 pb-28 lg:pb-12">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t('shared.title')}</h1>
        <p className="mt-1 text-ink-2">{t('shared.intro')}</p>
      </header>
      <TabRow
        label={t('shared.title')}
        tabs={[
          { value: 'mit-mir', label: unseen ? t('shared.withMeNew', { count: unseen }) : t('shared.withMe'), icon: Heart },
          { value: 'von-mir', label: t('shared.byMe'), icon: Share2 },
        ]}
        active={tab}
        onChange={(value: Tab) => setParams(value === 'mit-mir' ? {} : { tab: value }, { replace: true })}
      />
      {problem && <p className="text-sm text-bad">{errorText(problem)}</p>}
      {tab === 'mit-mir' ? (
        withMe === null ? null : withMe.length === 0 ? (
          <p className="card p-8 text-center text-ink-2">{t('shared.noneWithMe')}</p>
        ) : (
          <div className="grid gap-5 md:grid-cols-2">
            {withMe.map((item) => (
              <Link key={`${item.from.id}/${item.date}`} to={`/geteilt/${item.from.id}/${item.date}`} className="card group flex flex-col overflow-hidden">
                <CoverImage cover={item.cover} crop={item.cover_crop} className="aspect-[16/8] w-full" src={(id, preview) => sharedPhotoUrl(item.from.id, item.date, id, preview)} />
                <div className="flex flex-1 flex-col p-5">
                  <div className="flex items-center gap-2.5">
                    <Avatar person={item.from} size={30} />
                    <div className="min-w-0 flex-1 truncate text-sm">
                      <span className="font-semibold">{nameOf(item.from)}</span>
                      <span className="text-muted"> · {longDate(item.date, i18n.language)}</span>
                    </div>
                    {item.new && <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-accent-ink">{t('shared.new')}</span>}
                  </div>
                  <h2 className="mt-3 font-display text-xl font-semibold break-words group-hover:text-accent">{item.title || t('journal.untitled')}</h2>
                  <p className="mt-1.5 line-clamp-3 font-serif leading-relaxed text-ink-2">{item.excerpt}</p>
                  {item.heart && (
                    <p className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-accent">
                      <Heart size={13} fill="currentColor" aria-hidden /> {t('shared.heartSent')}
                    </p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )
      ) : byMe === null ? null : byMe.length === 0 ? (
        <p className="card p-8 text-center text-ink-2">{t('shared.noneByMe')}</p>
      ) : (
        <div className="card divide-y divide-line overflow-hidden">
          {byMe.map((item) => (
            <div key={item.date} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
              <CoverImage cover={item.cover} crop={item.cover_crop} className="h-14 w-20 shrink-0 rounded-lg" />
              <Link to={`/tag/${item.date}`} className="min-w-0 flex-1">
                <div className="truncate font-display text-lg font-semibold hover:text-accent">{item.title || t('journal.untitled')}</div>
                <div className="text-xs text-muted">{longDate(item.date, i18n.language, true)}</div>
              </Link>
              <div className="flex shrink-0 items-center gap-1.5">
                {item.people.map((person) => (
                  <span key={person.id} className="relative inline-flex" title={person.heart ? t('entry.heartFrom', { name: nameOf(person) }) : nameOf(person)}>
                    <Avatar person={person} size={28} />
                    {person.heart && (
                      <span className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full bg-sheet text-accent" aria-label={t('entry.heartFrom', { name: nameOf(person) })}>
                        <Heart size={10} fill="currentColor" aria-hidden />
                      </span>
                    )}
                  </span>
                ))}
              </div>
              {/* On a phone in a line of its own, under the day: it has to be reachable there too. */}
              <div className="basis-full pl-24 sm:basis-auto sm:pl-0">
                <button type="button" onClick={() => void stop(item)} className="shrink-0 rounded-full border border-line px-3.5 py-1.5 text-sm font-semibold text-ink-2 hover:bg-sheet-2">
                  {t('shared.stop')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="flex items-start gap-2 text-xs text-muted">
        <Lock size={13} className="mt-0.5 shrink-0" aria-hidden />
        {t('shared.note')}
      </p>
    </div>
  )
}

export function SharedEntryPage() {
  const { from = '', date = '' } = useParams()
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { refresh } = useShared()
  const { open } = useLightbox()
  const owner = /^\d{1,12}$/.test(from) ? Number(from) : null
  const [day, setDay] = useState<SharedDay | null>(null)
  const [gone, setGone] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setDay(null)
    setGone(false)
    if (owner === null) {
      setGone(true)
      return
    }
    sharingApi.day(owner, date).then(
      (found) => {
        if (!alive) return
        setDay(found)
        // Opened: no longer new. The mark at "Geteilt" follows at once.
        sharingApi.seen(owner, date).then(refresh, () => undefined)
      },
      (error) => {
        if (!alive) return
        if (error instanceof ApiError && error.code === 'not_found') setGone(true)
        else setProblem(error instanceof ApiError ? error.code : 'internal_error')
      },
    )
    return () => {
      alive = false
    }
  }, [owner, date, refresh])

  if (gone) return <p className="page pt-10 text-muted">{t('shared.gone')}</p>
  if (!day || owner === null) return <div className="page pt-10">{problem && <p className="text-sm text-bad">{errorText(problem)}</p>}</div>

  const hearted = day.heart !== null
  const src = (id: string, preview: boolean) => sharedPhotoUrl(owner, date, id, preview)
  /** The big view runs through the photos of this day that came with the share: the originals, through the share. */
  const coverPhoto = day.cover.startsWith('photo:') ? day.cover.slice('photo:'.length) : null
  const gallery = [...day.photos.map((photo) => photo.id), ...[coverPhoto, ...(day.notes ?? []).map((note) => note.photo_id)].filter((id): id is string => Boolean(id) && !day.photos.some((photo) => photo.id === id))].filter((id, index, all) => all.indexOf(id) === index)
  const openPhoto = (id: string, opener: HTMLElement) =>
    open(
      gallery.map((photoId) => ({ id: photoId, src: src(photoId, false) })),
      Math.max(0, gallery.indexOf(id)),
      opener,
    )
  const toggle = async () => {
    if (busy) return
    setBusy(true)
    try {
      const answer = await sharingApi.heart(owner, date, !hearted)
      setDay({ ...day, heart: answer.heart })
      if (answer.heart) navigate(location.pathname, { replace: true, state: { notice: t('shared.heartToast', { name: nameOf(day.from) }) } })
    } catch (error) {
      if (error instanceof ApiError && error.code === 'not_found') setGone(true)
      else setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page pb-28 lg:pb-12">
      <div className="flex items-center justify-between pt-6 pb-4">
        <Link to="/geteilt" className="inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-ink">
          <ArrowLeft size={15} aria-hidden /> {t('shared.back')}
        </Link>
        <span className="inline-flex items-center gap-1.5 text-sm text-muted">
          <Users size={15} aria-hidden /> {t('shared.onlyForYou')}
        </span>
      </div>
      {problem && <p className="mb-4 text-sm text-bad">{errorText(problem)}</p>}
      <article className="card overflow-hidden">
        <div className="relative">
          <CoverImage cover={day.cover} crop={day.cover_crop} large className="aspect-[16/8] w-full" src={src} />
          {coverPhoto && (
            <button type="button" onClick={(event) => openPhoto(coverPhoto, event.currentTarget)} className="absolute inset-0 cursor-zoom-in" aria-label={t('photoView.open')} data-cover-open />
          )}
        </div>
        <div className="px-6 py-8 sm:px-12 sm:py-10">
          <div className="flex items-center gap-3">
            <Avatar person={day.from} size={40} />
            <div className="min-w-0">
              <div className="truncate font-semibold">{nameOf(day.from)}</div>
              <div className="text-sm text-muted">{longDate(day.date, i18n.language, true)}</div>
            </div>
          </div>
          <h1 className="mt-6 mb-6 font-display text-3xl font-semibold tracking-tight break-words sm:text-[2.6rem] sm:leading-tight">{day.title || t('journal.untitled')}</h1>
          <Markdown text={day.text} photo={(id) => src(id, false)} />
          {day.photos.length > 0 && (
            <div className="mt-6 space-y-4">
              {day.photos.map((photo) => (
                <PhotoFigure key={photo.id} src={src(photo.id, false)} width={photo.width} height={photo.height} alt={t('photos.alt')} onOpen={(opener) => openPhoto(photo.id, opener)} />
              ))}
            </div>
          )}
          {day.tags.length > 0 && (
            <div className="mt-8 flex flex-wrap gap-2">
              {day.tags.map((tag) => (
                <span key={tag} className="max-w-full rounded-full bg-sheet-2 px-3 py-1 text-sm font-semibold break-all text-ink-2">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
        {day.values && day.values.length > 0 && (
          <div className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4" aria-label={t('shared.values')}>
            {day.values.map((value, index) => (
              <div key={index} className="bg-sheet px-5 py-4">
                <div className="text-xs font-semibold text-muted">{value.name}</div>
                <div className="mt-0.5 flex items-baseline gap-1">
                  <span className="font-display text-2xl font-semibold text-accent">{value.value}</span>
                  <span className="text-sm text-muted">/10</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {day.notes && day.notes.length > 0 && (
          <div className="border-t border-line px-6 py-4 sm:px-12">
            <p className="text-sm font-semibold text-muted">{t('shared.notes')}</p>
            <ul className="mt-3 space-y-2 rounded-xl bg-sheet-2 p-4 text-sm">
              {day.notes.map((note, index) => (
                <li key={index} className="flex gap-3">
                  <span className="w-10 shrink-0 font-bold text-muted tabular-nums">{timeOf(note.created_at, me?.profile?.timezone)}</span>
                  <span className="min-w-0 text-ink-2">
                    {note.prompt && <span className="block text-xs font-semibold text-muted">{note.prompt}</span>}
                    {note.text && <span className="break-words whitespace-pre-line">{note.text}</span>}
                    {note.photo_id && <PhotoTile src={src(note.photo_id, true)} alt={t('photos.alt')} onOpen={(opener) => openPhoto(note.photo_id as string, opener)} className="mt-1.5 h-16 w-24 rounded-lg" imageClassName="h-full w-full" />}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-6 py-4 sm:px-12">
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={busy}
            className={`inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold transition ${hearted ? 'bg-accent text-accent-ink' : 'border border-line text-ink-2 hover:bg-sheet-2'}`}
            aria-pressed={hearted}
          >
            <Heart size={16} fill={hearted ? 'currentColor' : 'none'} aria-hidden /> {hearted ? t('shared.hearted') : t('shared.heart')}
          </button>
          <span className="text-xs text-muted">{t('shared.heartHint')}</span>
        </div>
      </article>
    </div>
  )
}
