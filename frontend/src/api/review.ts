/**
 * Looking back and the book: a week or a month of the own pages, the strip on "Today", the summary by the AI, and a
 * year set as a PDF on the server. Everything worked out by the server from the signed-in person's own days.
 */
import { api, type CoverCropValue, type StatsValue } from './client'

export type ReviewKind = 'week' | 'month'

/** A day of the period: its rating of the main value, and its page when it has one. */
export type ReviewDay = {
  date: string
  value: number | null
  page: { title: string; cover: string; cover_crop?: CoverCropValue | null; unreadable: boolean } | null
}

export type Review = {
  kind: ReviewKind
  start: string
  end: string
  /** The period before and after, while there is one to look at (back to the first page, up to the last one over). */
  prev: string | null
  next: string | null
  days: ReviewDay[]
  written: number
  total: number
  unreadable: number
  value: StatsValue | null
  mean: number | null
  mean_before: number | null
  words: number
  photos: number
  best: { date: string; title: string; cover: string; cover_crop?: CoverCropValue | null; value: number } | null
  tags: { tag: string; count: number }[]
}

export type ReviewTeaser = {
  kind: ReviewKind
  start: string
  end: string
  written: number
  total: number
  covers: ({ date: string; cover: string; cover_crop?: CoverCropValue | null } | null)[]
}

export const reviewApi = {
  /** Empty `start`: the last one that is over. */
  get: (kind: ReviewKind, start?: string) => api<Review>(`/api/review/${kind}`, { query: start ? { start } : {} }),
  teaser: () => api<{ teaser: ReviewTeaser | null }>('/api/review/teaser'),
  /** Only on a press of the button: the own pages of the period go to the operator's service. */
  summary: (kind: ReviewKind, start: string) => api<{ text: string }>(`/api/review/${kind}/summary`, { method: 'POST', body: { start } }),
}

export type BookFormat = 'a5' | 'a4'
export type BookJob = { id: string; year: number; state: 'working' | 'done' | 'failed' | 'taken'; pages: number; error: string | null }

export const bookApi = {
  start: (year: number, format: BookFormat, photos: boolean, values: boolean, notes: boolean) =>
    api<BookJob>('/api/book', { method: 'POST', body: { year, format, photos, values, notes } }),
  status: (id: string) => api<BookJob>(`/api/book/${encodeURIComponent(id)}`),
  discard: (id: string) => api<void>(`/api/book/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** The finished PDF, fetched once by the browser itself (a download, not a request of the page). */
  pdfUrl: (id: string) => `/api/book/${encodeURIComponent(id)}/pdf`,
}
