/**
 * The photos of one day in the own Immich, for "Today" and the cover picker: asked for only while `enabled`, never
 * kept anywhere but here. Without Immich (not allowed, not connected, switched off) the list is null and nothing is
 * said; when Immich does not answer, `away` says so quietly and everything else goes on.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, immichApi, type ImmichPhoto, type Photo } from '../api/client'

/** Answers that only mean "no Immich here": the page shows none and says nothing. */
const ABSENT = new Set(['immich_closed', 'immich_not_connected', 'immich_suggest_off', 'immich_host_not_allowed'])

export function useImmichDay(date: string | undefined, enabled = true) {
  const [photos, setPhotos] = useState<ImmichPhoto[] | null>(null)
  const [away, setAway] = useState(false)
  const [taking, setTaking] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ code: string; values: Record<string, unknown> } | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    if (!date || !enabled) return
    let alive = true
    immichApi.photos(date).then(
      (day) => {
        if (!alive) return
        setPhotos(day.photos)
        setAway(false)
      },
      (error) => {
        if (!alive) return
        setPhotos(null)
        // Not there at all is no news; there but not answering is said, quietly.
        setAway(!(error instanceof ApiError && ABSENT.has(error.code)))
      },
    )
    return () => {
      alive = false
    }
  }, [date, enabled])

  /** Takes a photo for the day (copied now, once); the photo, or null when the server refused (said in `problem`). */
  const take = useCallback(
    async (asset: string, note = false): Promise<Photo | null> => {
      if (busy.current) return null
      busy.current = true
      setTaking(asset)
      setProblem(null)
      try {
        const photo = await immichApi.take(asset, date, note)
        if (!note) setPhotos((current) => current && current.map((entry) => (entry.id === asset ? { ...entry, photo_id: photo.id } : entry)))
        return photo
      } catch (error) {
        setProblem({ code: error instanceof ApiError ? error.code : 'internal_error', values: error instanceof ApiError ? error.values : {} })
        return null
      } finally {
        busy.current = false
        setTaking(null)
      }
    },
    [date],
  )

  /** A photo taken from Immich was deleted: its tile is free again. */
  const released = useCallback((photoId: string) => {
    setPhotos((current) => current && current.map((entry) => (entry.photo_id === photoId ? { ...entry, photo_id: null } : entry)))
  }, [])

  return { photos, away, taking, problem, take, released }
}

export type ImmichDayState = ReturnType<typeof useImmichDay>
