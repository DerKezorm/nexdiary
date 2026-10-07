/**
 * Uploading a photo. The upload carries an id made here: sent again after a lost answer (a train tunnel, a sleeping
 * phone), the server keeps one photo. Tried a second time only when the server could not be reached at all.
 */
import { ApiError, photosApi, type Photo } from '../api/client'
import { newId } from './ids'

export async function uploadPhoto(file: Blob, date?: string, forNote = false, forText = false): Promise<Photo> {
  const id = newId()
  try {
    return await photosApi.upload(file, id, date, forNote, forText)
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'network')) throw error
    return await photosApi.upload(file, id, date, forNote, forText)
  }
}

/** What the file picker offers: pictures of any kind (a list of types hides the camera on some phones). The server
 * takes JPEG, PNG, WebP, HEIC and AVIF and says so for anything else. */
export const PHOTO_ACCEPT = 'image/*'
