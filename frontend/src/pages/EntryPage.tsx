/**
 * One own day, read: as the mock's `EntryPage.tsx`. The cover (to change with the picker), the date, the title, the
 * text as it was written, the photos of the day, the tags, the values, who it is shared with (and who sent a heart),
 * the notes of the day folded away, and a year ago today. "Bearbeiten" leads into the writing page, "Teilen" opens the
 * dialog.
 */
import { ChevronDown, Crop, Heart, ImageIcon, Lock, PenLine, Share2, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'

import { ApiError, diaryApi, immichApi, journalApi, photosApi, photoUrl, sharingApi, type CoverCropValue, type DayPage, type DayShares, type ImmichEntry, type ImmichPhoto, type JournalDay, type Note, type Photo, type ValueDef } from '../api/client'
import { Avatar } from '../components/Avatar'
import { CoverCropDialog } from '../components/CropEditor'
import { LockDialog, LockedMark } from '../components/LockDay'
import { ImmichPicker } from '../components/ImmichPicker'
import { Markdown } from '../components/Markdown'
import { useOwnPhotoViewer } from '../components/ownPhotoViewer'
import { useDeletePhotos } from '../components/PhotoDelete'
import { PhotoFigure, PhotoTile } from '../components/PhotoViews'
import { ShareDialog } from '../components/ShareDialog'
import { YearAgo } from '../components/YearAgo'
import { CoverImage, CoverPicker } from '../covers/Cover'
import { addDays, longDate, timeOf, yearBefore } from '../lib/dates'
import { errorText } from '../lib/errors'
import { nameOf } from '../lib/people'
import { uploadPhoto } from '../lib/upload'
import { textPhotoIds } from '../lib/markdown'
import { useAuth } from '../state/auth'
import { useImmichDay, useImmichReady } from '../state/immich'

type Loaded = { day: DayPage; notes: Note[]; photos: Photo[]; values: ValueDef[]; shares: DayShares }

export function EntryPage() {
  const { date = '' } = useParams()
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [data, setData] = useState<Loaded | null>(null)
  const [missing, setMissing] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [raw, setRaw] = useState(false)
  const [share, setShare] = useState(false)
  const [locking, setLocking] = useState(false)
  const [picking, setPicking] = useState(false)
  /** The cut of the cover photo being chosen. */
  const [cropping, setCropping] = useState(false)
  /** The whole collection of the own Immich, to pick the cover from (the cover picker closes for it). */
  const [collection, setCollection] = useState(false)
  const immichReady = useImmichReady()
  const [uploading, setUploading] = useState(false)
  // The photos of the day in the own Immich, asked for only while the cover is being chosen.
  const immich = useImmichDay(date, picking)
  const [yearAgo, setYearAgo] = useState<JournalDay | null>(null)
  const { confirmDelete } = useDeletePhotos()

  const load = useCallback(async () => {
    try {
      const [day, notes, photos, values, shares] = await Promise.all([diaryApi.day(date), diaryApi.notes(date), photosApi.list(date), diaryApi.values(), sharingApi.ofDay(date)])
      setData({ day, notes, photos, values, shares })
      setMissing(false)
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'not_found' || error.code === 'date_invalid' || error.code === 'date_in_future')) setMissing(true)
      else setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }, [date])

  useEffect(() => {
    setData(null)
    setRaw(false)
    void load()
    // A year ago today: the newest day before the one after the same calendar day a year earlier, if it is that day.
    setYearAgo(null)
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const ago = yearBefore(date)
      journalApi.page(addDays(ago, 1), undefined, 1).then(
        (page) => setYearAgo(page.days[0]?.date === ago ? page.days[0] : null),
        () => undefined,
      )
    }
  }, [date, load])

  const say = (notice: string) => navigate(location.pathname, { replace: true, state: { notice } })

  const setCover = async (cover: string | null, crop: CoverCropValue | null = null) => {
    try {
      // Another cover starts without a cut on the server; the same one keeps its cut unless one is sent (none included).
      const same = cover === data?.day.cover
      const day = await diaryApi.changeDay(date, { cover, ...(cover?.startsWith('photo:') && (crop || same) ? { cover_crop: crop } : {}) })
      setData((current) => (current ? { ...current, day } : current))
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }

  const upload = async (file: File) => {
    setUploading(true)
    try {
      const photo = await uploadPhoto(file, date)
      setData((current) => (current ? { ...current, photos: current.photos.some((item) => item.id === photo.id) ? current.photos : [...current.photos, photo] } : current))
      await setCover(`photo:${photo.id}`)
      setPicking(false)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setUploading(false)
    }
  }

  /** A photo of Immich becomes a photo of this day (copied now), then its cover. */
  const takeFromImmich = async (entry: ImmichPhoto): Promise<string | null> => {
    const photo = await immich.take(entry.id)
    if (!photo) return null
    setData((current) => (current ? { ...current, photos: current.photos.some((item) => item.id === photo.id) ? current.photos : [...current.photos, photo] } : current))
    return photo.id
  }

  /** A photo of the whole collection, whenever it was shot, becomes a photo of this day and its cover. */
  const takeAny = async (entry: ImmichEntry) => {
    const photo = await immichApi.take(entry.id, date, false, true)
    setData((current) => (current ? { ...current, photos: current.photos.some((item) => item.id === photo.id) ? current.photos : [...current.photos, photo] } : current))
    await setCover(`photo:${photo.id}`)
  }

  /** Asks where the photo is used, then deletes it everywhere (title picture, text, notes) and loads the day again. */
  const removePhoto = async (photo: Photo) => {
    try {
      const result = await confirmDelete([photo.id])
      if (result && result.deleted.length > 0) await load()
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    }
  }
  const viewOwn = useOwnPhotoViewer(() => void load())

  if (missing)
    return (
      <div className="page pt-10 pb-28 lg:pb-12">
        <p className="text-muted">{t('entry.missing')}</p>
        <Link to={`/tag/${date}/schreiben`} className="mt-4 inline-flex h-11 items-center rounded-full bg-accent-soft px-5 font-semibold text-accent hover:brightness-[0.98]">
          {t('entry.write')}
        </Link>
      </div>
    )
  if (!data) return <div className="page pt-10 pb-28 lg:pb-12">{problem && <p className="text-sm text-bad">{errorText(problem)}</p>}</div>

  const { day, notes, photos, values, shares } = data
  const onNotes = new Set(notes.map((note) => note.photo_id).filter(Boolean))
  const coverPhoto = day.cover.startsWith('photo:') ? day.cover.slice('photo:'.length) : null
  const inText = new Set(textPhotoIds(day.text))
  const dayPhotos = photos.filter((photo) => !photo.on_note && !onNotes.has(photo.id) && photo.id !== coverPhoto && !inText.has(photo.id))
  // A cover taken from the notes goes to whoever the day is shared with, notes or not: the dialog says so.
  const coverFromNotes = coverPhoto !== null && (onNotes.has(coverPhoto) || photos.some((photo) => photo.id === coverPhoto && photo.on_note))
  const rated = values.filter((value) => day.values[value.id] !== undefined)
  /** The big view runs through all the photos of this day. */
  const openPhoto = (id: string, opener: HTMLElement) => viewOwn(photos.map((photo) => ({ id: photo.id })), Math.max(0, photos.findIndex((photo) => photo.id === id)), opener)
  const zone = me?.profile?.timezone

  return (
    <div className="page pb-28 lg:pb-12">
      <div className="flex items-center justify-between pt-6 pb-4">
        <Link to="/tagebuch" className="text-sm font-semibold text-muted hover:text-ink">
          {t('entry.back')}
        </Link>
        <div className="flex flex-wrap justify-end gap-2">
          {day.locked ? (
            <LockedMark label className="h-8 px-3.5 text-sm font-semibold text-muted" />
          ) : (
            <>
              <Link to={`/tag/${date}/schreiben`} className="inline-flex h-8 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold text-ink-2 transition hover:bg-sheet-2">
                <PenLine size={15} aria-hidden /> {t('entry.edit')}
              </Link>
              <button type="button" onClick={() => setLocking(true)} className="inline-flex h-8 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold text-ink-2 transition hover:bg-sheet-2">
                <Lock size={15} aria-hidden /> {t('lock.action')}
              </button>
            </>
          )}
          <button type="button" onClick={() => setShare(true)} className="inline-flex h-8 items-center justify-center gap-2 rounded-full bg-accent-soft px-3.5 text-sm font-semibold text-accent transition hover:brightness-[0.98]">
            <Share2 size={15} aria-hidden /> {t('entry.share')}
          </button>
        </div>
      </div>
      {problem && <p className="mb-4 text-sm text-bad">{errorText(problem)}</p>}
      <article className="card overflow-hidden">
        <div className="group relative">
          <CoverImage cover={day.cover} crop={day.cover_crop} large className="aspect-[16/8] w-full" />
          {coverPhoto && photos.some((photo) => photo.id === coverPhoto) && (
            <button type="button" onClick={(event) => openPhoto(coverPhoto, event.currentTarget)} className="absolute inset-0 cursor-zoom-in" aria-label={t('photoView.open')} data-cover-open />
          )}
          {!day.locked && (
            <span className="absolute right-3 bottom-3 flex gap-2">
              {coverPhoto && photos.some((photo) => photo.id === coverPhoto) && (
                <button type="button" onClick={() => setCropping(true)} className="inline-flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur hover:bg-black/60" data-cover-crop-open>
                  <Crop size={14} aria-hidden /> {t('cover.crop.short')}
                </button>
              )}
              <button type="button" onClick={() => setPicking(true)} className="inline-flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur hover:bg-black/60">
                <ImageIcon size={14} aria-hidden /> {t('entry.changeCover')}
              </button>
            </span>
          )}
        </div>
        <div className="px-6 py-8 sm:px-12 sm:py-10">
          <p className="text-sm font-semibold tracking-wide text-muted uppercase">{longDate(day.date, i18n.language, true)}</p>
          <h1 className="mt-1 mb-6 font-display text-3xl font-semibold tracking-tight break-words sm:text-[2.6rem] sm:leading-tight">{day.title || t('journal.untitled')}</h1>
          <Markdown text={day.text} />
          {dayPhotos.length > 0 && (
            <div className="mt-6 space-y-4">
              {dayPhotos.map((photo) => (
                <PhotoFigure key={photo.id} src={photoUrl(photo.id)} width={photo.width} height={photo.height} alt={t('photos.alt')} onOpen={(opener) => openPhoto(photo.id, opener)} />
              ))}
            </div>
          )}
          <div className="mt-8 flex flex-wrap gap-2">
            {day.tags.map((tag) => (
              <span key={tag} className="max-w-full rounded-full bg-sheet-2 px-3 py-1 text-sm font-semibold break-all text-ink-2">
                #{tag}
              </span>
            ))}
          </div>
        </div>
        {rated.length > 0 && (
          <div className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4">
            {rated.map((value) => (
              <div key={value.id} className="bg-sheet px-5 py-4">
                <div className="text-xs font-semibold text-muted">{value.name}</div>
                <div className="mt-0.5 flex items-baseline gap-1">
                  <span className="font-display text-2xl font-semibold text-accent">{day.values[value.id]}</span>
                  <span className="text-sm text-muted">/10</span>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="border-t border-line px-6 py-4 sm:px-12">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
            <span className="inline-flex items-center gap-2">
              {shares.people.length ? (
                <>
                  {t('entry.sharedWith')}{' '}
                  {shares.people.map((person) => (
                    <span key={person.id} className="relative inline-flex" title={person.heart ? t('entry.heartFrom', { name: nameOf(person) }) : nameOf(person)}>
                      <Avatar person={person} size={22} />
                      {person.heart && (
                        <span className="absolute -right-1 -bottom-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-sheet text-accent" aria-label={t('entry.heartFrom', { name: nameOf(person) })}>
                          <Heart size={9} fill="currentColor" aria-hidden />
                        </span>
                      )}
                    </span>
                  ))}
                </>
              ) : (
                <>
                  <Lock size={14} aria-hidden /> {t('entry.onlyYou')}
                </>
              )}
              {day.locked && day.locked_at && (
                <span className="ml-3 inline-flex items-center gap-1.5" data-locked-since>
                  <Lock size={14} aria-hidden /> {t('lock.since', { date: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'long', timeZone: zone || undefined }).format(new Date(day.locked_at)) })}
                </span>
              )}
            </span>
            {notes.length > 0 && (
              <button type="button" onClick={() => setRaw(!raw)} aria-expanded={raw} className="inline-flex items-center gap-1 font-semibold hover:text-ink">
                {day.written_by === 'ai' && <Sparkles size={13} aria-hidden />} {t('entry.notes')} <ChevronDown size={15} className={raw ? 'rotate-180' : ''} aria-hidden />
              </button>
            )}
          </div>
          {raw && (
            <ul className="mt-3 space-y-2 rounded-xl bg-sheet-2 p-4 text-sm">
              {notes.map((note) => (
                <li key={note.id} className="flex gap-3">
                  <span className="w-10 shrink-0 font-bold text-muted tabular-nums">{timeOf(note.created_at, zone)}</span>
                  <span className="min-w-0 text-ink-2">
                    {note.prompt && <span className="block text-xs font-semibold text-muted">{note.prompt}</span>}
                    {note.text && <span className="break-words whitespace-pre-line">{note.text}</span>}
                    {note.photo_id && <PhotoTile src={photoUrl(note.photo_id, true)} alt={t('photos.alt')} onOpen={(opener) => openPhoto(note.photo_id as string, opener)} className="mt-1.5 h-16 w-24 rounded-lg" imageClassName="h-full w-full" />}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </article>
      {yearAgo && <YearAgo day={yearAgo} />}
      {share && (
        <ShareDialog
          date={date}
          shares={shares}
          coverFromNotes={coverFromNotes}
          onClose={() => setShare(false)}
          onShared={(next, notice) => {
            setData((current) => (current ? { ...current, shares: next } : current))
            setShare(false)
            say(notice)
          }}
        />
      )}
      {locking && (
        <LockDialog
          date={date}
          onClose={() => setLocking(false)}
          onLocked={(locked) => {
            setData((current) => (current ? { ...current, day: locked } : current))
            setLocking(false)
            say(t('lock.done'))
          }}
        />
      )}
      {picking && !day.locked && (
        <CoverPicker
          date={date}
          tags={day.tags}
          photos={photos}
          value={day.cover}
          onChange={(cover) => void setCover(cover)}
          onClose={() => setPicking(false)}
          onUpload={(file) => void upload(file)}
          onDelete={removePhoto}
          uploading={uploading}
          immich={(immich.photos ?? []).filter((entry) => !entry.photo_id || !photos.some((photo) => photo.id === entry.photo_id))}
          taking={immich.taking}
          problem={immich.problem}
          onImmich={takeFromImmich}
          onMoreImmich={
            immichReady
              ? () => {
                  setPicking(false)
                  setCollection(true)
                }
              : undefined
          }
          onCrop={() => {
            setPicking(false)
            setCropping(true)
          }}
        />
      )}
      {cropping && !day.locked && coverPhoto && (
        <CoverCropDialog
          src={photoUrl(coverPhoto, true)}
          value={day.cover_crop ?? null}
          width={photos.find((photo) => photo.id === coverPhoto)?.width}
          height={photos.find((photo) => photo.id === coverPhoto)?.height}
          onClose={() => setCropping(false)}
          onDone={(crop) => {
            setCropping(false)
            void setCover(day.cover, crop)
          }}
        />
      )}
      {collection && !day.locked && <ImmichPicker date={date} onClose={() => setCollection(false)} onPick={takeAny} />}
    </div>
  )
}
