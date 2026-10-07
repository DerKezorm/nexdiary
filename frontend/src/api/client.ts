/**
 * The server's API. Every call names this browser tab in `X-Nexdiary-Client` (changes without it are refused, the
 * wall against requests from other sites). Errors come back as `ApiError` with the server's code; the page builds
 * its sentence from `errors.<code>` in the language files.
 */

import i18n from 'i18next'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly values: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

const CLIENT_KEY = 'nexdiary.client'
/** Sent on `window` when a request finds that the session is gone: the page goes back to the sign-in. */
export const SIGNED_OUT_EVENT = 'nexdiary:signed-out'

function randomId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return 'tab-' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

let clientId: string | null = null

/** One id per tab: sessionStorage survives a reload of the tab but is not shared with other tabs. */
export function tabId(): string {
  if (clientId) return clientId
  try {
    clientId = sessionStorage.getItem(CLIENT_KEY)
    if (!clientId) {
      clientId = randomId()
      sessionStorage.setItem(CLIENT_KEY, clientId)
    }
  } catch {
    clientId = randomId()
  }
  return clientId
}

type Options = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Record<string, string | number | boolean | string[] | undefined>
  body?: unknown
  /** A file as the body (an upload), sent as it is. */
  raw?: Blob
  /** The answer is a file, not JSON. */
  blob?: boolean
  /** Headers of its own, next to the ones every request carries (the password of an upload). */
  headers?: Record<string, string>
  /** Sent even while the page closes (the last draft). */
  keepalive?: boolean
}

const BUSY_TRIES = 3
const BUSY_WAIT_MS = 1500

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const repeatable = (options.method ?? 'GET') === 'GET'
  for (let attempt = 1; ; attempt++) {
    try {
      return await once<T>(path, options)
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'busy' && repeatable && attempt < BUSY_TRIES)) throw error
      await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS))
    }
  }
}

async function once<T>(path: string, options: Options): Promise<T> {
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item)
    else if (value !== undefined) url.searchParams.set(key, String(value))
  }
  // The language the page is shown in: what an account without a language of its own starts with (its values).
  const headers: Record<string, string> = { ...options.headers, Accept: 'application/json', 'X-Nexdiary-Client': tabId(), ...(i18n.language ? { 'X-Nexdiary-Language': i18n.language } : {}) }
  let body: BodyInit | undefined
  if (options.raw) body = options.raw
  else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  let response: Response
  try {
    response = await fetch(url.pathname + url.search, { method: options.method ?? 'GET', headers, body, ...(options.keepalive ? { keepalive: true } : {}) })
  } catch {
    throw new ApiError(0, 'network')
  }
  if (response.status === 204) return undefined as T
  if (options.blob && response.ok) return (await response.blob()) as T
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = data?.detail
    if (detail && typeof detail === 'object' && typeof detail.code === 'string') {
      const { code, message: _message, ...values } = detail
      if (code === 'sign_in_required') window.dispatchEvent(new Event(SIGNED_OUT_EVENT))
      throw new ApiError(response.status, code, values)
    }
    throw new ApiError(response.status, response.status === 401 ? 'sign_in_required' : 'internal_error')
  }
  return data as T
}

// ---- Types ----------------------------------------------------------------------------------------------------------

export type Layout = 'page' | 'columns' | 'chat'

export type Profile = {
  mode: 'system' | 'light' | 'dark'
  /** How "Today" is laid out. */
  layout: Layout
  /** A phone opens on the quick note. */
  quick_start: boolean
  /** The time zone; what "today" means for the server. */
  timezone: string
  /** Reported by a browser, or chosen by the person (then no browser changes it). */
  timezone_source: 'browser' | 'manual'
}

export type Me = {
  id: number
  name: string
  display_name: string
  role: 'operator' | 'member'
  sign_in: 'password' | 'oidc'
  email: string
  language: string
  oidc_linked: boolean
  two_factor: boolean
  two_factor_recovery_left: number
  avatar: string | null
  version: string
  whats_new_seen: string
  profile: Profile
  mail?: boolean
  second_factor_setup_required?: boolean
}

export type SetupState = { needs_setup: boolean; code_required: boolean; signed_in: boolean; version: string; min_password: number }
export type Methods = { password: boolean; oidc: boolean; oidc_name: string }

// ---- Calls ----------------------------------------------------------------------------------------------------------

export const authApi = {
  setupState: () => api<SetupState>('/api/setup'),
  setup: (name: string, password: string, code: string, language: string) =>
    api<Me>('/api/setup', { method: 'POST', body: { name, password, code, language } }),
  methods: () => api<Methods>('/api/auth/methods'),
  login: (name: string, password: string) => api<Me | { second_factor: true }>('/api/auth/login', { method: 'POST', body: { name, password } }),
  code: (code: string) => api<Me>('/api/auth/login/totp', { method: 'POST', body: { code } }),
  cancelCode: () => api<void>('/api/auth/login/totp/cancel', { method: 'POST' }),
  logout: () => api<void>('/api/auth/logout', { method: 'POST' }),
  me: () => api<Me>('/api/auth/me'),
  language: (language: string) => api<Me>('/api/me/language', { method: 'PUT', body: { language } }),
  preferences: (change: Partial<Profile>) => api<Profile>('/api/me/preferences', { method: 'PUT', body: change }),
  profile: (display_name: string) => api<Me>('/api/me/profile', { method: 'PUT', body: { display_name } }),
  password: (current: string, next: string) => api<void>('/api/auth/password', { method: 'PUT', body: { current, new: next } }),
  whatsNewSeen: () => api<Me>('/api/me/whats-new/seen', { method: 'POST' }),
}

export type ApiToken = {
  id: number
  name: string
  level: 'read'
  prefix: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  blocked: boolean
}
export type AnyApiToken = ApiToken & { account: string }

/** API tokens for programs (`/api/v1`); reading only. */
export const apiTokensApi = {
  list: () => api<{ allowed: boolean; tokens: ApiToken[] }>('/api/api-tokens'),
  make: (name: string, days: number | null) => api<{ token: ApiToken; secret: string }>('/api/api-tokens', { method: 'POST', body: { name, days } }),
  remove: (id: number) => api<void>(`/api/api-tokens/${id}`, { method: 'DELETE' }),
  every: () => api<AnyApiToken[]>('/api/admin/api-tokens'),
  block: (id: number) => api<AnyApiToken>(`/api/admin/api-tokens/${id}/block`, { method: 'POST' }),
}

/** The password for an upload rides in a header, as base64 of its UTF-8: a header carries no umlauts. */
export function passwordHeader(password: string): string {
  let bytes = ''
  for (const byte of new TextEncoder().encode(password)) bytes += String.fromCharCode(byte)
  return btoa(bytes)
}

export function avatarUrl(person: { id: number; avatar: string | null }): string | null {
  return person.avatar ? `/api/avatars/${person.id}?v=${encodeURIComponent(person.avatar)}` : null
}

// ---- The diary ------------------------------------------------------------------------------------------------------

export type Note = {
  id: string
  date: string
  text: string
  /** The sealed text did not open (damaged in the database); the note can only be deleted. */
  unreadable: boolean
  prompt: string | null
  photo_id: string | null
  created_at: string
  updated_at: string | null
}

export type ValueDef = { id: string; name: string; low: string; high: string; hint: string; active: boolean; position: number; unreadable?: boolean }

export type DayPage = {
  date: string
  title: string
  text: string
  tags: string[]
  values: Record<string, number>
  /** Always one: `illu:<motif>.<time>.<season>` or `photo:<id>`; the suggestion while none was chosen. */
  cover: string
  cover_chosen: boolean
  written_by: 'ai' | 'self' | null
  words: number
  /** Counts every change; a save names the one it started from (`base_revision`). */
  revision: number
  created_at: string
  updated_at: string
}

export type Photo = { id: string; date: string; source: 'upload' | 'immich'; width: number; height: number; created_at: string }

export type TodayData = { date: string; notes: Note[]; day: DayPage | null; values: ValueDef[]; streak: number; photos: Photo[] }

export type DayChange = {
  title?: string
  text?: string
  tags?: string[]
  values?: Record<string, number | null>
  written_by?: 'ai' | 'self' | null
  cover?: string | null
  /** The revision the writing started from (-1: there was no page): a newer page is not overwritten unseen. */
  base_revision?: number
}

export type Draft = { title: string; text: string; tags: string[]; cover: string | null; base_revision: number; updated_at: string }
export type DraftIn = Omit<Draft, 'updated_at'>

export const diaryApi = {
  today: () => api<TodayData>('/api/today'),
  notes: (date: string) => api<Note[]>('/api/notes', { query: { date } }),
  addNote: (id: string, text: string, date?: string, photoId?: string | null) =>
    api<Note>('/api/notes', { method: 'POST', body: { id, text, ...(date ? { date } : {}), ...(photoId ? { photo_id: photoId } : {}) } }),
  changeNote: (id: string, text: string) => api<Note>(`/api/notes/${encodeURIComponent(id)}`, { method: 'PUT', body: { text } }),
  deleteNote: (id: string) => api<void>(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  day: (date: string) => api<DayPage>(`/api/days/${encodeURIComponent(date)}`),
  changeDay: (date: string, change: DayChange) => api<DayPage>(`/api/days/${encodeURIComponent(date)}`, { method: 'PUT', body: change }),
  rate: (date: string, values: Record<string, number | null>) => api<DayPage>(`/api/days/${encodeURIComponent(date)}/values`, { method: 'PUT', body: { values } }),
  values: () => api<ValueDef[]>('/api/values'),
  addValue: (value: { name: string; low: string; high: string; hint?: string }) => api<ValueDef>('/api/values', { method: 'POST', body: value }),
  changeValue: (id: string, change: Partial<Pick<ValueDef, 'name' | 'low' | 'high' | 'hint' | 'active'>>) =>
    api<ValueDef>(`/api/values/${encodeURIComponent(id)}`, { method: 'PUT', body: change }),
  orderValues: (ids: string[]) => api<ValueDef[]>('/api/values/order', { method: 'PUT', body: { ids } }),
  deleteValue: (id: string) => api<void>(`/api/values/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** The draft of a day; null when there is none. */
  draft: (date: string) => api<Draft | null>(`/api/days/${encodeURIComponent(date)}/draft`),
  saveDraft: (date: string, draft: DraftIn, keepalive = false) => api<Draft>(`/api/days/${encodeURIComponent(date)}/draft`, { method: 'PUT', body: draft, keepalive }),
  deleteDraft: (date: string) => api<void>(`/api/days/${encodeURIComponent(date)}/draft`, { method: 'DELETE' }),
}

/** Photos of a day: uploaded as they are, drawn anew by the server without anything but their pixels. */
export const photosApi = {
  upload: (file: Blob, uploadId: string, date?: string) =>
    api<Photo>('/api/photos', { method: 'POST', raw: file, query: { upload_id: uploadId, ...(date ? { date } : {}) } }),
  list: (date: string) => api<Photo[]>('/api/photos', { query: { date } }),
  remove: (id: string) => api<void>(`/api/photos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/** Where a photo is shown from; the smaller copy for lists and tiles. */
export function photoUrl(id: string, preview = false): string {
  return `/api/photos/${encodeURIComponent(id)}${preview ? '/preview' : ''}`
}
