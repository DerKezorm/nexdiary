/**
 * A photo waiting beside the note field (on "Today" and in the quick note): picked, uploaded at once, shown small with
 * a way to drop it, and sent with the next note.
 */
import { Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { photoUrl, type Photo } from '../api/client'
import type { TodayState } from '../state/today'

/** A photo waiting beside the field for the note it goes with: picked, uploaded, shown small with a way to drop it. */
// eslint-disable-next-line react-refresh/only-export-components
export function usePendingPhoto(today: TodayState) {
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [busy, setBusy] = useState(false)
  const pick = async (file: File) => {
    setBusy(true)
    const made = await today.addPhoto(file, true)
    setBusy(false)
    if (made) setPhoto(made)
  }
  /** Taken back before the note went out: the photo was only for it. */
  const drop = () => {
    if (photo) void today.deletePhoto(photo.id)
    setPhoto(null)
  }
  return { photo, busy, pick, drop, sent: () => setPhoto(null) }
}

export function PendingPhoto({ photo, busy, onDrop }: { photo: Photo | null; busy: boolean; onDrop: () => void }) {
  const { t } = useTranslation()
  if (!photo && !busy) return null
  return (
    <div className="flex items-center gap-2 px-2 pt-1">
      <span className="relative inline-block overflow-hidden rounded-lg">
        {photo ? (
          <img src={photoUrl(photo.id, true)} alt={t('photos.alt')} className="h-14 w-20 object-cover" draggable={false} />
        ) : (
          <span className="flex h-14 w-20 items-center justify-center bg-sheet-2 text-muted">
            <Loader2 size={18} className="animate-spin" aria-label={t('photos.uploading')} />
          </span>
        )}
        {photo && (
          <button type="button" onClick={onDrop} className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/45 text-white" aria-label={t('photos.remove')}>
            <X size={12} strokeWidth={3} />
          </button>
        )}
      </span>
    </div>
  )
}
