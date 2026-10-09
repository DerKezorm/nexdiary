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
export type JournalLook = 'blog' | 'timeline'

export type Profile = {
  /** The accent colour (every one exists light and dark). */
  palette: 'salbei' | 'terrakotta' | 'pflaume' | 'altrosa' | 'tinte'
  mode: 'system' | 'light' | 'dark'
  /** How "Today" is laid out. */
  layout: Layout
  /** A phone opens on the quick note. */
  quick_start: boolean
  /** How the journal shows the days: large cards, or a line per day grouped by month. */
  journal: JournalLook
  /** The time zone; what "today" means for the server. */
  timezone: string
  /** Reported by a browser, or chosen by the person (then no browser changes it). */
  timezone_source: 'browser' | 'manual'
  /** The AI for this person (Account, AI); off: no button to write a day up, and the server refuses. */
  ai: boolean
  /** A push and a mail when the account signs in from a new device. */
  notify_login?: boolean
  /** Pages a week the person wants to write, 1 to 7 (7: every day). */
  goal?: number
  /** When and how to be reminded (changed with `pushApi.reminder`). */
  reminder?: Reminder
  /** Having yesterday written up in the morning on its own (changed with `aiApi.autowrite`). */
  autowrite?: Autowrite
  /** Taking part in the family question; off from the start. Leaving takes the own answers along. */
  family?: boolean
  /** The quiet hint on "Today" that others take part; false once put away. */
  family_hint?: boolean
}

/** Off from the start; `time` is the person's own clock, 04:00 to 11:59. */
export type Autowrite = { on: boolean; time: string; length: 'short' | 'long' }

export type ReminderMode = 'never' | 'daily' | 'pause'
export type Reminder = {
  mode: ReminderMode
  /** `HH:MM` on the person's own clock. */
  time: string
  /** After a pause: after so many days without an entry. */
  days: number
  /** Every day: not on a day with a note already. */
  skip_if_written: boolean
  /** The question of the day comes along. */
  with_prompt: boolean
  /** Also say so when the weekly goal is in danger (off from the start). */
  goal_risk?: boolean
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
  /** A second factor of any kind: a code from an app or a passkey. */
  two_factor: boolean
  /** A code from an app. */
  totp: boolean
  /** How many passkeys. */
  passkeys: number
  two_factor_recovery_left: number
  avatar: string | null
  version: string
  whats_new_seen: string
  profile: Profile
  mail?: boolean
  /** Whether this session may only set up the second factor, or (until set up) reaches only its own account page. */
  second_factor_setup_required?: boolean
  /** `setup`: right after the password, only the setup; `codes`: the recovery codes to confirm; `full`. */
  session_stage?: SessionStage
  /** The operator asks this account for a second factor: the last one cannot be turned off. */
  second_factor_required?: boolean
  /** What the operator allows this account (on from the start): the AI, a connection to Immich. */
  ai_allowed?: boolean
  immich_allowed?: boolean
}

export type SessionStage = 'full' | 'setup' | 'codes'
/** The first step went through and the account has a second factor: which kinds it may give. */
export type SecondFactorWaiting = { second_factor: true; totp: boolean; passkey: boolean }

export type SetupState = { needs_setup: boolean; code_required: boolean; signed_in: boolean; version: string; min_password: number }
export type Methods = { password: boolean; oidc: boolean; oidc_name: string; passkeys?: boolean; forgot?: boolean }
export type SignedSession = { id: string; device: string; phone: boolean; network: string; created_at: string; last_seen_at: string; remember: boolean; here: boolean }
export type Passkey = { id: string; name: string; created_at: string; last_used_at: string | null; credential: string }
export type Readiness = { points: { key: string; state: 'ok' | 'warn' | 'bad'; values: Record<string, unknown> }[]; open: number }

// ---- Calls ----------------------------------------------------------------------------------------------------------

export const authApi = {
  setupState: () => api<SetupState>('/api/setup'),
  setup: (name: string, password: string, code: string, language: string) =>
    api<Me>('/api/setup', { method: 'POST', body: { name, password, code, language } }),
  methods: () => api<Methods>('/api/auth/methods'),
  login: (name: string, password: string, remember = true) => api<Me | SecondFactorWaiting>('/api/auth/login', { method: 'POST', body: { name, password, remember } }),
  code: (code: string, remember?: boolean) => api<Me>('/api/auth/login/totp', { method: 'POST', body: { code, remember } }),
  /** The recovery codes are kept: the session that set up the second factor becomes a full one. */
  setupDone: () => api<Me>('/api/auth/setup/done', { method: 'POST' }),
  /** New recovery codes while they are being confirmed (a reload lost the ones shown). */
  setupCodes: () => api<{ recovery_codes: string[] }>('/api/auth/setup/codes', { method: 'POST' }),
  sessions: () => api<SignedSession[]>('/api/auth/sessions'),
  endSession: (id: string) => api<void>(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  logoutOthers: () => api<void>('/api/auth/logout-all', { method: 'POST' }),
  cancelCode: () => api<void>('/api/auth/login/totp/cancel', { method: 'POST' }),
  logout: () => api<void>('/api/auth/logout', { method: 'POST' }),
  me: () => api<Me>('/api/auth/me'),
  language: (language: string) => api<Me>('/api/me/language', { method: 'PUT', body: { language } }),
  preferences: (change: Partial<Profile>) => api<Profile>('/api/me/preferences', { method: 'PUT', body: change }),
  profile: (display_name: string) => api<Me>('/api/me/profile', { method: 'PUT', body: { display_name } }),
  password: (current: string, next: string) => api<void>('/api/auth/password', { method: 'PUT', body: { current, new: next } }),
  /** "Forgot your password?": a link to the address on record, if there is one; the answer is the same either way. */
  forgot: (name: string) => api<{ ok: true }>('/api/auth/forgot', { method: 'POST', body: { name } }),
  whatsNewSeen: () => api<Me>('/api/me/whats-new/seen', { method: 'POST' }),
}

export const passkeyApi = {
  list: () => api<Passkey[]>('/api/auth/passkeys'),
  begin: () => api<{ options: string }>('/api/auth/passkeys/begin', { method: 'POST' }),
  add: (credential: unknown, name: string, password: string) =>
    api<{ passkey: Passkey; recovery_codes: string[] | null; account: Me }>('/api/auth/passkeys', { method: 'POST', body: { credential, name, password } }),
  remove: (id: string, password: string) => api<Me>(`/api/auth/passkeys/${encodeURIComponent(id)}/remove`, { method: 'POST', body: { password } }),
  signInBegin: () => api<{ options: string }>('/api/auth/passkey/begin', { method: 'POST' }),
  signIn: (credential: unknown, remember: boolean) => api<Me>('/api/auth/passkey', { method: 'POST', body: { credential, remember } }),
  confirmBegin: () => api<{ options: string }>('/api/auth/passkeys/confirm/begin', { method: 'POST' }),
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
/** What the operator sees of a token: whose it is and its first characters, never what its owner called it. */
export type AnyApiToken = Omit<ApiToken, 'name'> & { account: string }

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
  /** The part of a photo cover that shows (`lib/textPhoto.ts`); null: the middle. */
  cover_crop?: CoverCropValue | null
  written_by: 'ai' | 'self' | null
  words: number
  /** Counts every change; a save names the one it started from (`base_revision`). */
  revision: number
  /** Locked for good: nothing of the day changes any more. */
  locked?: boolean
  locked_at?: string | null
  created_at: string
  updated_at: string
}

/** `on_note`: taken for a note; it goes with the notes, never with the photos of the day. */
/** Where a cover photo holds on to the frame (thousandths of the photo) and how far it zooms (percent). */
export type CoverCropValue = { x: number; y: number; zoom: number }

export type Photo = { id: string; date: string; source: 'upload' | 'immich'; width: number; height: number; created_at: string; on_note: boolean; for_text?: boolean }

/** Between 0:00 and 3:59 (`active`): the two days a note may belong to, and what the person answered (null: not yet). */
export type Night = { active: false } | { active: true; today: string; yesterday: string; choice: 'yesterday' | 'today' | null }
/** Days with notes and no page in the last sixty days, newest first. */
export type CatchUp = { count: number; auto?: number; days: { date: string; notes: number; start: string; auto?: boolean }[] }

/** The streak as the server works it out: counted in days at goal 7, else in weeks that reached the goal. `week` is
 * this week's pages against the goal, `rescues` the days or weeks (Mondays) a shield saved, newest first. */
export type StreakView = {
  unit: 'days' | 'weeks'
  goal: number
  current: number
  longest: number
  longest_end: string | null
  today_done: boolean
  shields: number
  week: { count: number; goal: number }
  rescues: string[]
}

/** `question`: the question of the day (writing prompts), null when the person switched questions off. `date` is
 * the day being kept: today, or after midnight the day the person said their notes belong to. */
export type TodayData = {
  date: string
  notes: Note[]
  day: DayPage | null
  values: ValueDef[]
  streak: number
  /** The streak with its unit, the goal, this week's count and the shields in hand. */
  series?: StreakView
  photos: Photo[]
  question?: Question | null
  night?: Night
  catch_up?: CatchUp
  /** Something begun on the day and not saved (a draft): with it, as with notes or a page, there is no "Nur kurz". */
  has_draft?: boolean
  /** The family question of today for whoever joined, else null. */
  family?: FamilyCard | null
  /** Others take part in the family question and this person has not joined nor put the hint away. */
  family_hint?: boolean
}

/** Somebody who joined the family question, and whether they answered today. */
export type FamilyPerson = Person & { me: boolean; answered: boolean }
/** The family question of today: who joined, who answered; the others' answers only once the own one is given
 * (`answers` is null until then). */
export type FamilyCard = {
  date: string
  question: Question
  people: FamilyPerson[]
  mine: { text: string; unreadable?: boolean; at: string } | null
  answers: { from: number; text: string; at: string }[] | null
}

export const familyApi = {
  card: () => api<FamilyCard>('/api/family'),
  /** The own answer for today, final once given (`family_answered` for a second one); it becomes a note too
   * (`noteId`: the same words with the same id again are the same press, one answer and one note). */
  answer: (date: string, text: string, noteId: string) => api<FamilyCard>('/api/family/answer', { method: 'PUT', body: { date, text, note_id: noteId } }),
  /** The question of a date with the answers, for the reading page of that day; null for a person who did not answer
   * then (nothing is said of the others). */
  ofDate: (date: string) => api<FamilyCard | null>(`/api/family/day/${encodeURIComponent(date)}`),
}

export type DayChange = {
  title?: string
  text?: string
  tags?: string[]
  values?: Record<string, number | null>
  written_by?: 'ai' | 'self' | null
  cover?: string | null
  /** Only with a photo cover; a new cover without it has none. */
  cover_crop?: CoverCropValue | null
  /** The revision the writing started from (-1: there was no page): a newer page is not overwritten unseen. */
  base_revision?: number
}

/** `written_by` "ai" while the writing began as a suggestion of the AI, and `ai_length` the length asked for. */
export type Draft = {
  title: string
  text: string
  tags: string[]
  cover: string | null
  cover_crop?: CoverCropValue | null
  written_by?: 'ai' | 'self' | null
  ai_length?: AiLength | null
  base_revision: number
  updated_at: string
  /** Made by the morning writing and not touched since: it waits for the person and is no page yet. */
  auto?: boolean
}
export type DraftIn = Omit<Draft, 'updated_at' | 'auto'>

export const diaryApi = {
  today: () => api<TodayData>('/api/today'),
  notes: (date: string) => api<Note[]>('/api/notes', { query: { date } }),
  addNote: (id: string, text: string, date?: string, photoId?: string | null, prompt?: Question | null) =>
    api<Note>('/api/notes', {
      method: 'POST',
      body: { id, text, ...(date ? { date } : {}), ...(photoId ? { photo_id: photoId } : {}), ...(prompt ? { prompt: prompt.text, ...(prompt.id ? { prompt_id: prompt.id } : {}) } : {}) },
    }),
  changeNote: (id: string, text: string) => api<Note>(`/api/notes/${encodeURIComponent(id)}`, { method: 'PUT', body: { text } }),
  /** To the day before or the day after its own; the photo of the note goes along. */
  moveNote: (id: string, direction: 'previous' | 'next') => api<Note>(`/api/notes/${encodeURIComponent(id)}/move`, { method: 'POST', body: { direction } }),
  /** Which day the notes written after midnight belong to, for the rest of the night and on every device. */
  night: (choice: 'yesterday' | 'today') => api<Night>('/api/night', { method: 'PUT', body: { choice } }),
  catchUp: () => api<CatchUp>('/api/catch-up'),
  /** Locks a written day for good. There is no call that undoes it. */
  lock: (date: string) => api<DayPage>(`/api/days/${encodeURIComponent(date)}/lock`, { method: 'POST' }),
  deleteNote: (id: string) => api<void>(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  day: (date: string) => api<DayPage>(`/api/days/${encodeURIComponent(date)}`),
  changeDay: (date: string, change: DayChange) => api<DayPage>(`/api/days/${encodeURIComponent(date)}`, { method: 'PUT', body: change }),
  /** Deletes the page of a day: its shares and its draft go with it, the notes and the photos of the day stay. */
  deleteDay: (date: string) => api<void>(`/api/days/${encodeURIComponent(date)}`, { method: 'DELETE' }),
  /** "Heute nur kurz": the page of today out of one sentence and the first value; only while there is no page. */
  short: (date: string, entry: { text: string; title: string; rating?: number; cover: string }) =>
    api<DayPage>(`/api/days/${encodeURIComponent(date)}/short`, { method: 'POST', body: entry }),
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

// ---- The AI and the writing prompts ---------------------------------------------------------------------------------

export type AiProvider = 'none' | 'local' | 'openai' | 'messages'
export type AiLength = 'short' | 'long'
/** What a person may know about the AI: whether there is one for them (`available`), of which kind, the host the notes
 * go to for a service on the internet (`to`), and the own switch (`mine`). */
export type AiState = { provider: AiProvider; to: string; model: string; mine: boolean; allowed?: boolean; available: boolean; auto_allowed?: boolean }
export type AiSettings = { provider: AiProvider; url: string; model: string; key_set: boolean; auto_allowed?: boolean }
export type AiModel = { id: string; name: string }
/** A question of the AI about a note of the day (`note_id`, written at `at`). */
export type Followup = { question: string; note_id: string; at: string }

export const aiApi = {
  state: () => api<AiState>('/api/ai'),
  /** Only on a press of the button: the own notes of the day go to the operator's service. */
  formulate: (date: string, length: AiLength, template?: string) =>
    api<{ title: string; text: string; length: AiLength }>('/api/ai/formulate', { method: 'POST', body: { date, length, ...(template ? { template } : {}) } }),
  /** "Erst fragen lassen": up to two questions about what the notes of the day leave open (sent like `formulate`). */
  followups: (date: string) => api<{ questions: Followup[] }>('/api/ai/followups', { method: 'POST', body: { date } }),
  settings: () => api<AiSettings>('/api/settings/ai'),
  save: (change: Partial<Omit<AiSettings, 'key_set'>> & { key?: string }) => api<AiSettings>('/api/settings/ai', { method: 'PUT', body: change }),
  /** Having yesterday written up in the morning on its own; switching it on needs `confirmed` (the person was told
   * where the notes go). */
  autowrite: (change: Partial<Autowrite> & { confirmed?: boolean }) => api<Autowrite>('/api/me/autowrite', { method: 'PUT', body: change }),
  models: (typed: { provider?: AiProvider; url?: string; key?: string }) => api<AiModel[]>('/api/settings/ai/models', { method: 'POST', body: typed }),
  probe: () => api<{ seconds: number }>('/api/settings/ai/probe', { method: 'POST' }),
}

/** A writing prompt: its stable id (`schoen.0`, `own.<hex>`) and its words in the person's language. */
export type Question = { id: string; text: string }
export type PromptSet = { id: string; name: string; questions: string[]; on: boolean }
export type PromptChoice = { on: boolean; sets: PromptSet[]; own: Question[] }

/** Every change is a single one, made on what stands: two tabs never overwrite each other's choice. */
export const promptsApi = {
  choice: () => api<PromptChoice>('/api/prompts'),
  switch: (on: boolean) => api<PromptChoice>('/api/prompts', { method: 'PUT', body: { on } }),
  switchSet: (id: string, on: boolean) => api<PromptChoice>(`/api/prompts/sets/${encodeURIComponent(id)}`, { method: 'PUT', body: { on } }),
  addOwn: (text: string) => api<PromptChoice>('/api/prompts/own', { method: 'POST', body: { text } }),
  removeOwn: (id: string) => api<PromptChoice>(`/api/prompts/own/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  another: () => api<{ question: Question | null }>('/api/prompts/another', { method: 'POST' }),
  pool: (date: string) => api<{ questions: (Question & { answered: boolean })[] }>('/api/prompts/pool', { query: { date } }),
}

/** A section of a template: a heading of the page, and what it is about as a hint (may be empty). */
export type TemplateSection = { heading: string; question: string }
export type Template = { id: string; name: string; sections: TemplateSection[] }
/** A template as it is sent: a new one has no id yet. */
export type TemplateIn = { id?: string; name: string; sections: TemplateSection[] }
/** All templates of the person, the default one, and the revision they were read at (-1: nothing saved yet). */
export type TemplateSet = { templates: Template[]; default: string | null; revision: number }
/** What `formulate` takes as `template` when the person wants none. */
export const NO_TEMPLATE = 'none'

/** The whole list is replaced at once, onto the revision that was read: a list changed elsewhere meanwhile is refused
 * (`templates_changed`) and read again. */
export const templatesApi = {
  get: () => api<TemplateSet>('/api/templates').then(shapedTemplates),
  save: (templates: TemplateIn[], defaultId: string | null, revision: number) =>
    api<TemplateSet>('/api/templates', { method: 'PUT', body: { templates, default: defaultId, revision } }).then(shapedTemplates),
}

/** The answer as a list of templates, whatever came: an answer that is not one reads as no templates. */
function shapedTemplates(found: TemplateSet | null | undefined): TemplateSet {
  return {
    templates: Array.isArray(found?.templates) ? found.templates : [],
    default: typeof found?.default === 'string' ? found.default : null,
    revision: typeof found?.revision === 'number' ? found.revision : -1,
  }
}

/** Photos of a day: uploaded as they are, drawn anew by the server without anything but their pixels. */
export const photosApi = {
  upload: (file: Blob, uploadId: string, date?: string, forNote = false, forText = false) =>
    api<Photo>('/api/photos', { method: 'POST', raw: file, query: { upload_id: uploadId, ...(date ? { date } : {}), ...(forNote ? { note: true } : {}), ...(forText ? { text: true } : {}) } }),
  list: (date: string) => api<Photo[]>('/api/photos', { query: { date } }),
  remove: (id: string) => api<void>(`/api/photos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Where a photo is used: the cover of its day, its text, notes. Asked before it is deleted. */
  uses: (id: string) => api<PhotoUses>(`/api/photos/${encodeURIComponent(id)}/uses`),
  /** Deletes several at once; a photo of a locked day stays (`locked`). */
  removeMany: (ids: string[]) => api<PhotoDeletion>('/api/photos/delete', { method: 'POST', body: { ids } }),
  /** All own photos, newest day first, a page at a time; `unused` keeps those that nothing uses. */
  library: (before = '', unused = false, limit = 60) => api<LibraryPage>('/api/photos/library', { query: { limit, ...(before ? { before } : {}), ...(unused ? { unused: 1 } : {}) } }),
  storage: () => api<PhotoStorage>('/api/photos/storage'),
}

export type PhotoUses = { cover: boolean; text: boolean; notes: { id: string; date: string }[]; date: string; locked: boolean }
export type PhotoDeletion = { deleted: string[]; locked: string[]; missing: string[] }
export type LibraryPhoto = Photo & { uses: { cover: boolean; text: boolean; notes: { id: string; date: string }[] } }
export type LibraryPage = { photos: LibraryPhoto[]; next: string | null }
export type PhotoStorage = { used: number; limit: number | null; count: number }

/** The own Immich, as its card shows it. With the operator's bolt closed only `allowed: false`; the key never comes
 * back, only whether one is stored. */
export type ImmichState = { allowed: boolean; connected: boolean; account_blocked?: boolean; url?: string; key_set?: boolean; suggest?: boolean; email?: string; version?: string }
/** A photo of the own Immich on a day: its id there, when it was taken, and the photo taken from it, if one was. */
export type ImmichPhoto = { id: string; taken_at: string; photo_id: string | null; uploaded_at?: string }
/** A photo of the whole collection (no "taken already" mark: it is taken for whichever day is being written). */
export type ImmichEntry = { id: string; taken_at: string }
export type ImmichPage = { photos: ImmichEntry[]; next: number | null }
export type ImmichSearch = ImmichPage & { mode: 'smart' | 'metadata' }
/** Uploaded lately: `uploaded_at` is when it reached Immich, `taken_at` when it was shot. */
export type ImmichRecent = { date: string; photos: ImmichPhoto[]; more: boolean }
export type ImmichAlbum = { id: string; name: string; count: number; cover: string | null }
export type ImmichAlbums = { available: boolean; needed?: string; albums: ImmichAlbum[] }
export type ImmichDay = { date: string; photos: ImmichPhoto[]; more: boolean }
export type ImmichProbe = { version: string; today: number; more: boolean; email: string }
export type ImmichSettings = { allowed: boolean; hosts: string[]; connected: number }

/** Immich, always through nexdiary: the browser never learns the address or the key, and a photo is copied only when
 * it is taken. */
export const immichApi = {
  state: () => api<ImmichState>('/api/immich'),
  save: (change: { url?: string; key?: string; suggest?: boolean }) => api<ImmichState>('/api/immich', { method: 'PUT', body: change }),
  disconnect: () => api<void>('/api/immich', { method: 'DELETE' }),
  probe: () => api<ImmichProbe>('/api/immich/probe', { method: 'POST' }),
  photos: (date?: string) => api<ImmichDay>('/api/immich/photos', { query: { date } }),
  take: (asset: string, date?: string, note = false, anywhen = false, forText = false) =>
    api<Photo>(`/api/immich/photos/${encodeURIComponent(asset)}`, {
      method: 'POST',
      body: { ...(date ? { date } : {}), ...(note ? { note: true } : {}), ...(anywhen ? { anywhen: true } : {}), ...(forText ? { text: true } : {}) },
    }),
  /** The whole collection, newest first; `until` (a day or a month) starts with what was taken up to its end. */
  timeline: (page = 1, until = '') => api<ImmichPage>('/api/immich/timeline', { query: { page, ...(until ? { until } : {}) } }),
  recent: (date?: string) => api<ImmichRecent>('/api/immich/recent', { query: date ? { date } : {} }),
  albums: () => api<ImmichAlbums>('/api/immich/albums'),
  albumPhotos: (album: string, page = 1) => api<ImmichPage>(`/api/immich/albums/${encodeURIComponent(album)}/photos`, { query: { page } }),
  /** The word travels in the body, never in an address. */
  search: (q: string, page = 1) => api<ImmichSearch>('/api/immich/search', { method: 'POST', body: { q, page } }),
  settings: () => api<ImmichSettings>('/api/settings/immich'),
  saveSettings: (change: { allowed?: boolean; hosts?: string[] }) => api<ImmichSettings>('/api/settings/immich', { method: 'PUT', body: change }),
}

export type PushDevice = { id: string; name: string; phone: boolean; since: string; last: string | null }
export type PushState = { key: string; devices: PushDevice[] }
export type PushResult = { sent: number; gone: number; failed: number }
export type PushSettings = { devices: number; key: string; contact: string; contact_used: string; known: string[]; hosts: string[] }

/** Web Push: the own devices, a probe, the reminder; the operator's card. */
export const pushApi = {
  state: () => api<PushState>('/api/push'),
  add: (subscription: { endpoint: string; p256dh: string; auth: string; installed: boolean }) =>
    api<PushDevice>('/api/push/devices', { method: 'POST', body: subscription }),
  lookup: (endpoint: string) => api<{ id: string | null }>('/api/push/devices/lookup', { method: 'POST', body: { endpoint } }),
  rename: (id: string, name: string) => api<PushDevice>(`/api/push/devices/${encodeURIComponent(id)}`, { method: 'PUT', body: { name } }),
  remove: (id: string) => api<void>(`/api/push/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  probe: () => api<PushResult>('/api/push/test', { method: 'POST' }),
  reminder: (change: Partial<Reminder>) => api<Reminder>('/api/me/reminder', { method: 'PUT', body: change }),
  settings: () => api<PushSettings>('/api/settings/push'),
  saveSettings: (change: { contact?: string; hosts?: string[] }) => api<PushSettings>('/api/settings/push', { method: 'PUT', body: change }),
  renew: (current_password: string) => api<PushSettings>('/api/settings/push/renew', { method: 'POST', body: { current_password } }),
}

/** The small picture of a photo in the own Immich, through nexdiary. */
export function immichThumbUrl(asset: string): string {
  return `/api/immich/photos/${encodeURIComponent(asset)}/thumbnail`
}

/** Where a photo is shown from; the smaller copy for lists and tiles. */
export function photoUrl(id: string, preview = false): string {
  return `/api/photos/${encodeURIComponent(id)}${preview ? '/preview' : ''}`
}

// ---- The journal and sharing ----------------------------------------------------------------------------------------

/** Somebody on this server, as everybody may see them. */
export type Person = { id: number; name: string; display_name: string; avatar: string | null }

/** Somebody a day is shared with, what they see, and the heart they sent (when). */
export type Recipient = Person & { with_values: boolean; with_notes: boolean; heart: string | null }

export type JournalDay = {
  date: string
  title: string
  /** The start of the text in plain words. */
  excerpt: string
  tags: string[]
  cover: string
  cover_crop?: CoverCropValue | null
  written_by: 'ai' | 'self' | null
  /** The first value asked, as rated that day. */
  first_value: { name: string; value: number } | null
  shared_with: Recipient[]
  /** Locked for good. */
  locked?: boolean
  unreadable: boolean
}

export type JournalPage = { days: JournalDay[]; more: boolean }
/** A volume of the shelf: a year with its pages, out of how many days, and the pages of each month. */
export type JournalVolume = { year: number; pages: number; days: number; months: number[] }
export type JournalOverview = { count: number; since: string | null; tags: { tag: string; count: number }[]; volumes?: JournalVolume[]; year?: number; days_left?: number }

export type SearchHit = { date: string; kind: 'title' | 'text' | 'tag' | 'note'; snippet: string; note_id?: string }
export type SearchResult = { results: SearchHit[]; more: boolean; days: Record<string, JournalDay> }

export type DayShares = { date: string; people: Recipient[]; with_values: boolean; with_notes: boolean }
export type SharedByMe = { date: string; title: string; cover: string; cover_crop?: CoverCropValue | null; people: Recipient[]; unreadable: boolean }

export type SharedItem = { from: Person; date: string; title: string; excerpt: string; cover: string; cover_crop?: CoverCropValue | null; new: boolean; heart: string | null }

export type SharedDay = {
  from: Person
  date: string
  title: string
  text: string
  tags: string[]
  cover: string
  cover_crop?: CoverCropValue | null
  photos: { id: string; width: number; height: number }[]
  with_values: boolean
  with_notes: boolean
  heart: string | null
  shared_at: string
  /** Only when the day was shared with its ratings. */
  values?: { name: string; low: string; high: string; value: number }[]
  /** Only when the day was shared with its notes. */
  notes?: { text: string; prompt: string | null; photo_id: string | null; created_at: string }[]
}

export const journalApi = {
  /** In the body, never in the address: tags are as private as the text. */
  page: (before?: string, tag?: string, limit = 24, year?: number) =>
    api<JournalPage>('/api/journal', { method: 'POST', body: { limit, ...(before ? { before } : {}), ...(tag ? { tag } : {}), ...(year ? { year } : {}) } }),
  overview: () => api<JournalOverview>('/api/journal/overview'),
  /** In the body, never in the address: an address ends up in logs and the history. */
  search: (q: string) => api<SearchResult>('/api/search', { method: 'POST', body: { q } }),
}

// ---- The statistics -------------------------------------------------------------------------------------------------

/** A value as the statistics name it, with the words at its two ends. */
export type StatsValue = { id: string; name: string; low: string; high: string }
/** A day the statistics point to: the best or the worst one, or the one a year ago. */
export type StatsDay = { date: string; title: string; excerpt: string; cover: string; cover_crop?: CoverCropValue | null; value?: number }
/** A comparison of two groups of days by the main value: how many days each, their means, the difference. */
export type StatsCompare = { a_n: number; b_n: number; a_mean: number; b_mean: number; diff: number; similar: boolean }
export type StatsTogether = ({ kind: 'value'; name: string } | { kind: 'weekend' } | { kind: 'tag'; tag: string }) & StatsCompare
export type StatsExtremes = { count: number; best: StatsDay | null; worst: StatsDay | null }
export type StatsSpan = '30' | '365' | 'all'
export type StatsRange = '30' | '90' | '180'

export type Stats = {
  today: string
  pages: number
  unreadable: number
  /** The value most of the page is about (the first one asked); null while none is asked. */
  value: StatsValue | null
  values: StatsValue[]
  tiles: Partial<StreakView> & Pick<StreakView, 'current' | 'longest' | 'longest_end' | 'today_done'> & { year: number; days_year: number; days_total: number; words: number; words_per_day: number }
  calendar: { start: string; weeks: number; days: { date: string; written: boolean; value: number | null; title: string }[] }
  series: { days: number; end: string; values: Record<string, { values: (number | null)[]; means: (number | null)[]; mean: Record<StatsRange, number | null> }> }
  weekdays: { days: { n: number; mean: number | null }[]; best: number | null }
  together: StatsTogether[]
  tags: { tag: string; count: number }[]
  extremes: Record<StatsSpan, StatsExtremes>
  writing: { total: number; ai: number; self: number; photos: number; shared: number }
  year_ago: StatsDay | null
}

export const statsApi = {
  get: () => api<Stats>('/api/stats'),
}

const shared = (owner: number, date: string) => `/api/shared/${encodeURIComponent(String(owner))}/${encodeURIComponent(date)}`

export const sharingApi = {
  people: () => api<Person[]>('/api/people'),
  ofDay: (date: string) => api<DayShares>(`/api/days/${encodeURIComponent(date)}/shares`),
  share: (date: string, to: number[], withValues: boolean, withNotes: boolean) =>
    api<DayShares>(`/api/days/${encodeURIComponent(date)}/shares`, { method: 'PUT', body: { to, with_values: withValues, with_notes: withNotes } }),
  stop: (date: string) => api<void>(`/api/days/${encodeURIComponent(date)}/shares`, { method: 'DELETE' }),
  byMe: () => api<SharedByMe[]>('/api/shares'),
  withMe: () => api<SharedItem[]>('/api/shared'),
  count: () => api<{ new: number }>('/api/shared/count'),
  day: (owner: number, date: string) => api<SharedDay>(shared(owner, date)),
  seen: (owner: number, date: string) => api<void>(`${shared(owner, date)}/seen`, { method: 'POST' }),
  heart: (owner: number, date: string, on: boolean) => api<{ heart: string | null }>(`${shared(owner, date)}/heart`, { method: on ? 'PUT' : 'DELETE' }),
}

/** A photo of a day shared with me: only through the share, never through the owner's own address. */
export function sharedPhotoUrl(owner: number, date: string, id: string, preview = false): string {
  return `${shared(owner, date)}/photos/${encodeURIComponent(id)}${preview ? '/preview' : ''}`
}

/** A time capsule for me: who sent it (null: an account deleted since), its title and its days; whether it is open
 * for me and not read yet, and whether it holds a photo (only once it is open). */
export type CapsuleForMe = { id: string; from: Person | null; self: boolean; title: string; opens_on: string; written_on: string; open: boolean; new: boolean; photo?: boolean }
/** A time capsule I sent: to whom (`hidden`: how many more, blocked, that I cannot see now), whether it is sealed for me
 * too (only to myself), whether it opened for anybody. */
export type CapsuleFromMe = { id: string; title: string; opens_on: string; written_on: string; to: Person[]; hidden: number; sealed: boolean; opened: boolean; revision: number }
export type CapsuleLists = { today: string; for_me: CapsuleForMe[]; from_me: CapsuleFromMe[]; new: number }
/** One capsule as far as I may see it now: `text` and `photo` only once I may read it; `to`, `revision` and `opened`
 * only for its sender. */
export type CapsuleView = {
  id: string
  from: Person | null
  self: boolean
  title: string
  opens_on: string
  written_on: string
  sealed: boolean
  for_me: boolean
  open: boolean
  text?: string
  photo?: boolean
  to?: Person[]
  hidden?: number
  revision?: number
  opened?: boolean
}
/** What a capsule says. `photo`: an id of a photo chosen for it, null for none; left out on a change, the photo stays. */
export type CapsuleDraft = { to: number[]; opens_on: string; title: string; text: string; photo?: string | null }

const capsule = (id: string) => `/api/capsules/${encodeURIComponent(id)}`

export const capsulesApi = {
  lists: () => api<CapsuleLists>('/api/capsules'),
  count: () => api<{ new: number }>('/api/capsules/count'),
  one: (id: string) => api<CapsuleView>(capsule(id)),
  create: (clientId: string, draft: CapsuleDraft) => api<CapsuleView>('/api/capsules', { method: 'POST', body: { id: clientId, ...draft } }),
  change: (id: string, revision: number, draft: CapsuleDraft) => api<CapsuleView>(capsule(id), { method: 'PUT', body: { revision, ...draft } }),
  withdraw: (id: string) => api<void>(capsule(id), { method: 'DELETE' }),
  read: (id: string) => api<void>(`${capsule(id)}/read`, { method: 'POST' }),
  upload: (file: Blob, uploadId: string) => api<{ id: string; width: number; height: number }>('/api/capsules/photos', { method: 'POST', raw: file, query: { upload_id: uploadId } }),
  /** A chosen photo that is not going to be sealed with a capsule: gone at once. */
  dropPhoto: (id: string) => api<void>(`/api/capsules/photos/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

/** The photo of a capsule, for whoever may read it now. */
export function capsulePhotoUrl(id: string, preview = false): string {
  return `${capsule(id)}/photo${preview ? '/preview' : ''}`
}
