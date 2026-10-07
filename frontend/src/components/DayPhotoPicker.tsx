/** "Aus den Fotos dieses Tages": the photos already kept for the day, to put one into the text. */
import { ImageOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { photoUrl, type Photo } from '../api/client'
import { timeOf } from '../lib/dates'
import { useAuth } from '../state/auth'
import { Dialog } from './Dialog'

export function DayPhotoPicker({ photos, onPick, onClose }: { photos: Photo[]; onPick: (photo: Photo) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  return (
    <Dialog title={t('editor.imageDayTitle')} onClose={onClose}>
      {photos.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">
          <ImageOff size={18} className="mx-auto mb-1" aria-hidden /> {t('editor.imageDayNone')}
        </p>
      ) : (
        <ul className="grid grid-cols-3 gap-2" data-day-photos>
          {photos.map((photo) => (
            <li key={photo.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(photo)
                  onClose()
                }}
                aria-label={`${t('editor.imageDayPick')} ${timeOf(photo.created_at, me?.profile?.timezone)}`}
                className="relative block w-full overflow-hidden rounded-xl transition hover:-translate-y-0.5"
              >
                <img src={photoUrl(photo.id, true)} alt="" className="aspect-square w-full object-cover" draggable={false} />
                <span className="absolute bottom-1 left-1.5 rounded bg-black/35 px-1 text-[0.68rem] font-bold text-white">{timeOf(photo.created_at, me?.profile?.timezone)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}
