import { useCallback } from 'react'

import { photoUrl } from '../api/client'
import { useLightbox, type ViewerPhoto } from './Lightbox'
import { useDeletePhotos } from './PhotoDelete'

/**
 * Opens the big view over own photos: the original from the own route, with the question before deleting. `onGone`
 * is told which photo went, so that the page can load again. A list of photos of one place (the day, the notes) is the
 * list the arrows run through.
 */
export function useOwnPhotoViewer(onGone?: (id: string) => void) {
  const { open } = useLightbox()
  const { confirmDelete } = useDeletePhotos()
  return useCallback(
    (photos: { id: string; caption?: string }[], index: number, opener?: HTMLElement | null) => {
      const list: ViewerPhoto[] = photos.map((photo) => ({
        id: photo.id,
        src: photoUrl(photo.id),
        caption: photo.caption,
        onDelete: async () => {
          const result = await confirmDelete([photo.id])
          if (!result?.deleted.includes(photo.id)) return false
          onGone?.(photo.id)
          return true
        },
      }))
      open(list, index, opener)
    },
    [open, confirmDelete, onGone],
  )
}
