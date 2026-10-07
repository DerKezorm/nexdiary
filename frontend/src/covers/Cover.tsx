/* eslint-disable react-refresh/only-export-components */
/**
 * Every day has a cover: its own photo, or one of the illustrations (`drawings.tsx`). As the mock's `Cover.tsx`: the
 * picture itself, and the picker with the day's photos, what fits the day, a search and filters over all of them.
 */
import { Check, Crop, ImageIcon, ImagePlus, Images, Loader2, Search, Trash2 } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { immichThumbUrl, photoUrl, type ImmichPhoto, type Photo } from '../api/client'
import { Dialog } from '../components/Dialog'
import { errorText } from '../lib/errors'
import { coverCropOf, coverStyle, isCoverMiddle, type CoverCrop } from '../lib/textPhoto'
import { PHOTO_ACCEPT } from '../lib/upload'
import { Illustration, useIlluName } from './drawings'
import { ALL_ILLUS, GROUPS, ILLU, isIllustration, MOTIFS, PHOTO, photoOf, SEASONS, seasonOf, suggestIllus, TIMES, type Season, type Time } from './suggest'

/** The cover to show when nothing was chosen: the first own photo of the day, else the illustration that fits. */
export function defaultCover(date: string, tags: string[], photos: Photo[], time: Time = 'abend'): string {
  return photos[0] ? `${PHOTO}${photos[0].id}` : `${ILLU}${suggestIllus(date, tags, time)[0]}`
}

/** A cover as a picture: an own photo (the large one or its smaller copy) or an illustration. A photo of a day shared
 * by somebody else comes through the share (`src`), never through the owner's own address. A photo with its own cut
 * (`crop`, `lib/textPhoto.ts`) shows that part in every frame, whatever its shape: the frame holds on to the same
 * point of the photo and zooms around it. */
export function CoverImage({
  cover,
  crop = null,
  className = '',
  large = false,
  alt = '',
  src = photoUrl,
}: {
  cover: string
  crop?: CoverCrop | null
  className?: string
  large?: boolean
  alt?: string
  src?: (id: string, preview: boolean) => string
}) {
  const photo = photoOf(cover)
  const cut = photo ? coverCropOf(crop) : null
  if (photo && cut && !isCoverMiddle(cut))
    return (
      <span className={`block overflow-hidden ${className}`} data-cover-crop>
        <img src={src(photo, !large)} alt={alt} className="block h-full w-full object-cover" style={coverStyle(cut)} draggable={false} />
      </span>
    )
  if (photo) return <img src={src(photo, !large)} alt={alt} className={`object-cover ${className}`} draggable={false} />
  return <Illustration id={isIllustration(cover) ? cover.slice(ILLU.length) : 'baum.abend.herbst'} className={className} />
}

export function CoverPicker({
  date,
  tags,
  photos,
  value,
  onChange,
  onClose,
  onUpload,
  onDelete,
  uploading = false,
  time = 'abend',
  immich = [],
  onImmich,
  onMoreImmich,
  taking = null,
  problem = null,
  onCrop,
}: {
  date: string
  tags: string[]
  photos: Photo[]
  value: string
  onChange: (cover: string) => void
  onClose: () => void
  /** A photo picked from the device, to become the cover once it is uploaded. */
  onUpload?: (file: File) => void
  /** Deletes an own photo; asked here first. */
  onDelete?: (photo: Photo) => Promise<void>
  uploading?: boolean
  time?: Time
  /** Photos of the day in the own Immich that were not taken yet: picking one copies it, then it is the cover. */
  immich?: ImmichPhoto[]
  /** Takes a photo of Immich for the day; the id of the photo it became, or null when that did not work. */
  onImmich?: (photo: ImmichPhoto) => Promise<string | null>
  /** Opens the whole collection of the own Immich to pick from (the page closes this dialog); left out without one. */
  onMoreImmich?: () => void
  /** The photo of Immich being taken right now. */
  taking?: string | null
  /** What went wrong taking a photo of Immich. */
  problem?: { code: string; values: Record<string, unknown> } | null
  /** Opens the editor of the cut, offered while the cover is a photo (the page closes this dialog for it). */
  onCrop?: () => void
}) {
  const { t } = useTranslation()
  const illuName = useIlluName()
  const [group, setGroup] = useState<string | null>(null)
  const [hour, setHour] = useState<Time | null>(null)
  const [season, setSeason] = useState<Season | null>(seasonOf(date))
  const [query, setQuery] = useState('')
  const [asking, setAsking] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const suggestions = suggestIllus(date, tags, time)
  const list = useMemo(
    () =>
      ALL_ILLUS.filter((id) => {
        const [m, tt, s] = id.split('.')
        const motif = MOTIFS.find((x) => x.id === m)
        return (!group || motif?.group === group) && (!hour || tt === hour) && (!season || s === season) && (!query || illuName(id).toLowerCase().includes(query.trim().toLowerCase()))
      }),
    [group, hour, season, query, illuName],
  )
  const pick = (next: string) => {
    onChange(next)
    onClose()
  }
  const Tile = ({ v, children, label }: { v: string; children: ReactNode; label: string }) => (
    <button
      type="button"
      onClick={() => pick(v)}
      title={label}
      aria-label={label}
      aria-pressed={value === v}
      className={`relative overflow-hidden rounded-xl transition hover:-translate-y-0.5 ${value === v ? 'ring-3 ring-accent' : ''}`}
    >
      {children}
      {value === v && (
        <span className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-accent-ink">
          <Check size={14} strokeWidth={3} />
        </span>
      )}
    </button>
  )
  const chip = (on: boolean) => `rounded-full px-3 py-1 text-xs font-bold transition ${on ? 'bg-accent text-accent-ink' : 'bg-sheet-2 text-ink-2 hover:bg-accent-soft'}`
  return (
    <Dialog title={t('covers.title')} onClose={onClose} wide>
      <p className="-mt-2 mb-4 text-sm text-ink-2">{t('covers.intro', { count: ALL_ILLUS.length })}</p>
      {onCrop && photoOf(value) && (
        <button type="button" onClick={onCrop} className="mb-4 inline-flex h-9 items-center gap-1.5 rounded-full bg-accent-soft px-4 text-sm font-semibold text-accent hover:brightness-[0.98]" data-cover-crop-open>
          <Crop size={15} aria-hidden /> {t('cover.crop.open')}
        </button>
      )}
      {problem && (
        <p role="alert" className="mb-4 rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {errorText(problem.code, problem.values)}
        </p>
      )}
      {(photos.length > 0 || onUpload || immich.length > 0) && (
        <>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-bold tracking-wide text-muted uppercase">{t('covers.ownPhotos')}</h3>
            {onMoreImmich && (
              <button type="button" onClick={onMoreImmich} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-sheet-2 px-3 text-xs font-semibold text-ink-2 hover:bg-accent-soft hover:text-accent">
                <Images size={14} aria-hidden /> {t('covers.moreImmich')}
              </button>
            )}
          </div>
          <div className="mb-5 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {photos.map((photo) => (
              <div key={photo.id} className="group relative">
                <Tile v={`${PHOTO}${photo.id}`} label={t('covers.ownPhoto')}>
                  <img src={photoUrl(photo.id, true)} alt="" className="aspect-[16/11] w-full object-cover" draggable={false} />
                </Tile>
                {onDelete && asking !== photo.id && (
                  <button
                    type="button"
                    onClick={() => setAsking(photo.id)}
                    className="absolute bottom-1.5 left-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/45 text-white opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
                    aria-label={t('covers.deletePhoto')}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
                {onDelete && asking === photo.id && (
                  <div role="alertdialog" aria-label={t('covers.deleteAsk')} className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 rounded-xl bg-black/70 p-1.5 text-center text-xs font-semibold text-white">
                    <span>{t('covers.deleteAsk')}</span>
                    <span className="flex gap-1.5">
                      <button
                        type="button"
                        disabled={deleting}
                        onClick={async () => {
                          setDeleting(true)
                          await onDelete(photo)
                          setDeleting(false)
                          setAsking(null)
                        }}
                        className="rounded-full bg-white px-2.5 py-1 text-bad"
                      >
                        {t('covers.deleteYes')}
                      </button>
                      <button type="button" onClick={() => setAsking(null)} className="rounded-full px-2.5 py-1 text-white hover:bg-white/15">
                        {t('common.cancel')}
                      </button>
                    </span>
                  </div>
                )}
              </div>
            ))}
            {onImmich &&
              immich.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  disabled={taking !== null}
                  onClick={async () => {
                    const id = await onImmich(entry)
                    if (id) pick(`${PHOTO}${id}`)
                  }}
                  title={t('covers.ownPhoto')}
                  aria-label={t('covers.ownPhoto')}
                  aria-pressed={false}
                  className="relative overflow-hidden rounded-xl transition hover:-translate-y-0.5"
                >
                  <img src={immichThumbUrl(entry.id)} alt="" className="aspect-[16/11] w-full object-cover" draggable={false} />
                  {taking === entry.id && (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/30 text-white">
                      <Loader2 size={20} className="animate-spin" aria-hidden />
                    </span>
                  )}
                </button>
              ))}
            {onUpload && (
              <button
                type="button"
                onClick={() => file.current?.click()}
                disabled={uploading}
                className="flex aspect-[16/11] w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-line text-sm font-semibold text-muted hover:border-accent hover:text-accent disabled:opacity-60"
              >
                {uploading ? <Loader2 size={20} className="animate-spin" /> : <ImagePlus size={20} />}
                {t('photos.upload')}
              </button>
            )}
          </div>
          {onUpload && (
            <input
              ref={file}
              type="file"
              accept={PHOTO_ACCEPT}
              className="hidden"
              aria-label={t('photos.upload')}
              onChange={(e) => {
                const picked = e.target.files?.[0]
                e.target.value = ''
                if (picked) onUpload(picked)
              }}
            />
          )}
        </>
      )}
      <h3 className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">{t('covers.fits')}</h3>
      <div className="mb-5 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {suggestions.map((id) => (
          <Tile key={id} v={`${ILLU}${id}`} label={illuName(id)}>
            <Illustration id={id} className="aspect-[16/11] w-full" />
          </Tile>
        ))}
      </div>
      <div className="sticky -top-6 z-10 -mx-6 space-y-2 border-y border-line bg-sheet px-6 py-3">
        <label className="flex items-center gap-2 rounded-full border border-line bg-paper px-3 py-1.5">
          <Search size={15} className="text-muted" aria-hidden />
          <input
            value={query}
            maxLength={60}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('covers.search')}
            aria-label={t('covers.searchLabel')}
            className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
          />
          <span className="text-xs whitespace-nowrap text-muted">{t('covers.count', { count: list.length })}</span>
        </label>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={chip(!group)} onClick={() => setGroup(null)} aria-pressed={!group}>
            {t('covers.allMotifs')}
          </button>
          {GROUPS.map((g) => (
            <button key={g} type="button" className={chip(group === g)} onClick={() => setGroup(group === g ? null : g)} aria-pressed={group === g}>
              {t(`covers.groups.${g}`)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TIMES.map((id) => (
            <button key={id} type="button" className={chip(hour === id)} onClick={() => setHour(hour === id ? null : id)} aria-pressed={hour === id}>
              {t(`covers.times.${id}`)}
            </button>
          ))}
          <span className="mx-1 w-px bg-line" />
          {SEASONS.map((id) => (
            <button key={id} type="button" className={chip(season === id)} onClick={() => setSeason(season === id ? null : id)} aria-pressed={season === id}>
              {t(`covers.seasons.${id}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
        {list.slice(0, 96).map((id) => (
          <Tile key={id} v={`${ILLU}${id}`} label={illuName(id)}>
            <Illustration id={id} className="aspect-[16/11] w-full" />
          </Tile>
        ))}
      </div>
      {list.length === 0 && (
        <p className="py-8 text-center text-sm text-muted">
          <ImageIcon size={18} className="mx-auto mb-1" /> {t('covers.nothing')}
        </p>
      )}
    </Dialog>
  )
}
