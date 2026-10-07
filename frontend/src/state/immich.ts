/**
 * The photos of one day in the own Immich, for the writing view and the cover picker, or (`mode: 'recent'`, for
 * "Today") what was uploaded lately, newest upload first: Immich often receives a phone's photos hours late, so the
 * shots of today are not yet there when the day is. Asked for only while `enabled`, never kept anywhere but here. Without Immich (not allowed, not connected, switched off) the list is null and nothing is
 * said; when Immich does not answer, `away` says so quietly and everything else goes on.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError, immichApi, type ImmichPhoto, type Photo } from '../api/client'

/** Answers that only mean "no Immich here": the page shows none and says nothing. */
const ABSENT = new Set(['immich_closed', 'immich_not_connected', 'immich_suggest_off', 'immich_host_not_allowed'])

export function useImmichDay(date: string | undefined, enabled = true, mode: 'day' | 'recent' = 'day') {
  const [photos, setPhotos] = useState<ImmichPhoto[] | null>(null)
  const [away, setAway] = useState(false)
  /** Whether there is a connected Immich at all (even with the photos of the day switched off): null until known. */
  const [connected, setConnected] = useState<boolean | null>(null)
  const [taking, setTaking] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ code: string; values: Record<string, unknown> } | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    if (!date || !enabled) return
    let alive = true
    // First whether there is an Immich to ask at all (always answered): no refused request for nothing, no red line
    // in the browser's console on every visit while the operator keeps Immich closed.
    immichApi
      .state()
      .then((state) => {
        if (alive) setConnected(Boolean(state.allowed && state.connected))
        if (!state.allowed || !state.connected || state.suggest === false) throw new ApiError(409, 'immich_not_connected')
        return mode === 'recent' ? immichApi.recent(date) : immichApi.photos(date)
      })
      .then(
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
  }, [date, enabled, mode])

  /** Takes a photo for the day (copied now, once); the photo, or null when the server refused (said in `problem`). */
  const take = useCallback(
    async (asset: string, note = false): Promise<Photo | null> => {
      if (busy.current) return null
      busy.current = true
      setTaking(asset)
      setProblem(null)
      try {
        const photo = await immichApi.take(asset, date, note, mode === 'recent')
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
    [date, mode],
  )

  /** A photo taken from Immich was deleted: its tile is free again. */
  const released = useCallback((photoId: string) => {
    setPhotos((current) => current && current.map((entry) => (entry.photo_id === photoId ? { ...entry, photo_id: null } : entry)))
  }, [])

  return { photos, away, connected, taking, problem, take, released }
}

export type ImmichDayState = ReturnType<typeof useImmichDay>

/** Whether there is an Immich to pick from at all (allowed, and connected): null while that is being asked. Always
 * answered by the server, so no refused request lands in the console of a visitor whose operator keeps Immich closed. */
export function useImmichReady(): boolean | null {
  const [ready, setReady] = useState<boolean | null>(null)
  useEffect(() => {
    let alive = true
    immichApi.state().then(
      (state) => alive && setReady(Boolean(state.allowed && state.connected)),
      () => alive && setReady(false),
    )
    return () => {
      alive = false
    }
  }, [])
  return ready
}
