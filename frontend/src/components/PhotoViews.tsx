/**
 * How a photo stands on a page. A small tile (notes, the strip on "Today", pickers) may crop, always around the middle;
 * a large photo (the reading page, a shared day) keeps the shape it has: the width of the column, the height of the
 * picture up to a sensible limit, and above that the whole picture inside, never cut. Both open the big view when
 * tapped (`components/Lightbox.tsx`).
 */
import { useTranslation } from 'react-i18next'


/** The shape of the photo, for the box before the picture has loaded (nothing jumps). */
function ratio(width?: number, height?: number): string | undefined {
  return width && height ? `${width} / ${height}` : undefined
}

/** A photo as wide as its column, as high as it is, up to `max-h`; taller than that the whole picture stays inside. */
export function PhotoFigure({ src, width, height, alt = '', onOpen, className = '' }: { src: string; width?: number; height?: number; alt?: string; onOpen?: (opener: HTMLElement) => void; className?: string }) {
  const { t } = useTranslation()
  const image = (
    <img src={src} alt={alt} loading="lazy" draggable={false} style={{ aspectRatio: ratio(width, height) }} className="block max-h-[34rem] w-full rounded-xl bg-sheet-2 object-contain" data-photo-figure />
  )
  if (!onOpen) return <div className={className}>{image}</div>
  return (
    <button type="button" onClick={(event) => onOpen(event.currentTarget)} aria-label={alt || t('photoView.open')} className={`block w-full cursor-zoom-in rounded-xl text-left ${className}`}>
      {image}
    </button>
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
