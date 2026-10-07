/**
 * The camera button beside the note field: it takes or picks a photo for the next note. With an Immich connected it
 * offers two ways ("Foto aufnehmen oder wählen", "Aus Immich") in a small menu above the button; without one it opens
 * the device's picker at once, as before.
 */
import { Camera, Images } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ImmichPicker } from './ImmichPicker'
import type { usePendingPhoto } from './PendingPhoto'
import { PHOTO_ACCEPT } from '../lib/upload'
import { useImmichReady } from '../state/immich'

export function PhotoSourceButton({
  pending,
  date,
  size = 20,
  className,
  label,
}: {
  pending: ReturnType<typeof usePendingPhoto>
  /** The day the note goes to: the photo of Immich is kept for it. */
  date: string | undefined
  size?: number
  className: string
  label: string
}) {
  const { t } = useTranslation()
  const immich = useImmichReady()
  const [menu, setMenu] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const holder = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!menu) return
    const away = (event: PointerEvent) => {
      if (!holder.current?.contains(event.target as Node)) setMenu(false)
    }
    const key = (event: KeyboardEvent) => event.key === 'Escape' && setMenu(false)
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', key)
    }
  }, [menu])
  return (
    <span ref={holder} className="relative inline-flex">
      <button
        type="button"
        onClick={() => (immich ? setMenu((current) => !current) : file.current?.click())}
        disabled={pending.busy}
        className={className}
        title={t('photos.alt')}
        aria-label={label}
        aria-haspopup={immich ? 'menu' : undefined}
        aria-expanded={immich ? menu : undefined}
      >
        <Camera size={size} />
      </button>
      {menu && (
        <div role="menu" aria-label={label} className="card absolute bottom-full left-0 z-30 mb-2 w-60 p-1.5 shadow-soft" data-photo-menu>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false)
              file.current?.click()
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-semibold text-ink-2 hover:bg-sheet-2 hover:text-ink"
          >
            <Camera size={16} aria-hidden /> {t('photos.takeOrPick')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false)
              setChoosing(true)
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-semibold text-ink-2 hover:bg-sheet-2 hover:text-ink"
          >
            <Images size={16} aria-hidden /> {t('photos.fromImmichNote')}
          </button>
        </div>
      )}
      <input
        ref={file}
        type="file"
        accept={PHOTO_ACCEPT}
        className="hidden"
        aria-label={label}
        onChange={(event) => {
          const picked = event.target.files?.[0]
          event.target.value = ''
          if (picked) void pending.pick(picked)
        }}
      />
      {choosing && date && <ImmichPicker date={date} onClose={() => setChoosing(false)} onPick={(entry) => pending.pickImmich(entry.id, date)} />}
    </span>
  )
}
