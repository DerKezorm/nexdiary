/**
 * How a photo stands on a page. A small tile (notes, the strip on "Today", pickers) may crop, always around the middle;
 * the photos of a day (the reading page, a shared day) stand as previews in their own shape, rows of them. Both open
 * the big view with the whole picture when tapped (`components/Lightbox.tsx`).
 */
import { ZoomIn } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'


/** The narrowest and the widest shape a preview takes; beyond that it crops around the middle (the big view shows all). */
const GALLERY_RATIO = { min: 0.5, max: 2.5 } as const

/** The shape of a preview: the photo's own, held between the narrowest and the widest one. Unknown: a square. */
function galleryRatio(width?: number, height?: number): number {
  if (!width || !height) return 1
  return Math.min(GALLERY_RATIO.max, Math.max(GALLERY_RATIO.min, width / height))
}

export type GalleryPhoto = { id: string; src: string; width?: number; height?: number }

/**
 * The photos of a day as small previews in rows, each in its own shape (upright, wide, square), the rows filling the
 * column at one height; the last row keeps the plain height instead of stretching. A magnifier on every preview says
 * that a tap opens the big view with the whole picture.
 */
export function PhotoGallery({ photos, alt = '', onOpen, className = '' }: { photos: GalleryPhoto[]; alt?: string; onOpen: (id: string, opener: HTMLElement) => void; className?: string }) {
  const { t } = useTranslation()
  return (
    <div className={`photo-gallery ${className}`} data-photo-gallery>
      {photos.map((photo) => {
        const shape = galleryRatio(photo.width, photo.height)
        return (
          <button
            key={photo.id}
            type="button"
            onClick={(event) => onOpen(photo.id, event.currentTarget)}
            aria-label={alt || t('photoView.open')}
            className="photo-gallery-item group"
            style={{ '--shape': shape } as CSSProperties}
          >
            <img src={photo.src} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover object-center" data-photo-preview />
            <span className="absolute right-1.5 bottom-1.5 grid size-7 place-items-center rounded-full bg-black/45 text-white backdrop-blur transition group-hover:bg-black/65" aria-hidden>
              <ZoomIn size={15} />
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** A small tile that opens the big view; it may crop, around the middle. */
export function PhotoTile({ src, alt = '', onOpen, className = '', imageClassName = '' }: { src: string; alt?: string; onOpen?: (opener: HTMLElement) => void; className?: string; imageClassName?: string }) {
  const { t } = useTranslation()
  const image = <img src={src} alt={onOpen ? '' : alt} loading="lazy" draggable={false} className={`object-cover object-center ${imageClassName}`} />
  if (!onOpen) return <span className={className}>{image}</span>
  return (
    <button type="button" onClick={(event) => onOpen(event.currentTarget)} aria-label={alt || t('photoView.open')} className={`block cursor-zoom-in overflow-hidden ${className}`}>
      {image}
    </button>
  )
}
