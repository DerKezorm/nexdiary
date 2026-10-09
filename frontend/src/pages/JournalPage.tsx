/**
 * The journal, as the mock's `Journal.tsx`: the own days as a blog (large cards, the newest one big) or a timeline (a
 * line per day, grouped by month), as the account chose under My account, Look. A search over texts and notes (in the
 * body of a request, never in the address) and the tags as filters.
 *
 * The server sends the days a page at a time and opens only those; the next page comes when the end of the list
 * comes into view, or with the button below it.
 */
import { LayoutGrid, List, Lock, Search, Sparkles, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { ApiError, authApi, diaryApi, journalApi, type CatchUp, type JournalDay, type JournalLook, type JournalOverview, type SearchResult } from '../api/client'
import { Avatar } from '../components/Avatar'
import { CatchUpCard } from '../components/CatchUp'
import { Chip } from '../components/Chip'
import { Shelf } from '../components/Shelf'
import { CoverImage } from '../covers/Cover'
import { longDate } from '../lib/dates'
import { errorText } from '../lib/errors'
import { useAuth } from '../state/auth'

/** How long typing rests before the search goes out: a search opens every page, so not one per letter. */
const SEARCH_PAUSE_MS = 350

/** An entry of the list; from a search it may be a day with notes only (no page yet), shown with its snippet. */
type Shown = JournalDay & { onlyNotes?: boolean }

// eslint-disable-next-line react-refresh/only-export-components
export function mark(text: string, q: string): ReactNode {
  if (!q) return text
  const at = text.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded bg-accent-soft px-0.5 text-ink">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  )
}

/** The entries a search found, newest day first: a day with a page as the journal lists it, the start of its text
 * replaced by the place the word was found; a day with notes only as its snippet. */
// eslint-disable-next-line react-refresh/only-export-components
export function searchEntries(result: SearchResult): Shown[] {
  const out: Shown[] = []
  const seen = new Set<string>()
  for (const hit of result.results) {
    if (seen.has(hit.date)) continue
    seen.add(hit.date)
    const day = result.days[hit.date]
    const snippet = hit.kind === 'text' || hit.kind === 'note' ? hit.snippet : null
    if (day) out.push({ ...day, excerpt: snippet ?? day.excerpt })
    else
      out.push({
        date: hit.date,
        title: '',
        excerpt: hit.snippet,
        tags: [],
        cover: '',
        written_by: null,
        first_value: null,
        shared_with: [],
        unreadable: false,
        onlyNotes: true,
      })
  }
  return out
}

/**
 * Blog or timeline, switched right in the journal: two small buttons, kept with the account like the card under My
 * account, Look (both stay the same thing). Shown at once, put right if the server refuses.
 */
function LookSwitch({ look }: { look: JournalLook }) {
  const { t } = useTranslation()
  const { me, setMe } = useAuth()
  const choose = async (next: JournalLook) => {
    if (!me || next === look) return
    setMe({ ...me, profile: { ...me.profile, journal: next } })
    try {
      setMe({ ...me, profile: await authApi.preferences({ journal: next }) })
    } catch {
      setMe(me)
    }
  }
  const options: { value: JournalLook; label: string; icon: typeof List }[] = [
    { value: 'blog', label: t('journal.viewBlog'), icon: LayoutGrid },
    { value: 'timeline', label: t('journal.viewTimeline'), icon: List },
  ]
  return (
    <div role="group" aria-label={t('journal.view')} className="inline-flex shrink-0 rounded-full border border-line bg-sheet p-1" data-look-switch>
      {options.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          onClick={() => void choose(value)}
          aria-pressed={look === value}
          aria-label={label}
          title={label}
          className={`rounded-full p-2 transition ${look === value ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink'}`}
        >
          <Icon size={17} aria-hidden />
        </button>
      ))}
    </div>
  )
}

export function JournalPage() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const look = me?.profile?.journal ?? 'blog'
  const [overview, setOverview] = useState<JournalOverview | null>(null)
  /** Days with notes and no page: their own section above the list. */
  const [catchUp, setCatchUp] = useState<CatchUp | null>(null)
  const [days, setDays] = useState<JournalDay[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  /** The volume opened on the shelf: only its year, asked of the server. */
  const [year, setYear] = useState<number | null>(null)
  const [found, setFound] = useState<SearchResult | null>(null)
  const [searching, setSearching] = useState(false)
  /** Counts the loads: an answer to an older one (another tag meanwhile) is thrown away. */
  const round = useRef(0)
  const query = q.trim()

  useEffect(() => {
    journalApi.overview().then(setOverview, (error) => setProblem(error instanceof ApiError ? error.code : 'internal_error'))
    diaryApi.catchUp().then(setCatchUp, () => undefined)
  }, [])

  const load = useCallback(async (before: string | undefined, withTag: string | null, current: number, inYear: number | null) => {
    setLoading(true)
    try {
      const page = await journalApi.page(before, withTag ?? undefined, undefined, inYear ?? undefined)
      if (current !== round.current) return
      setDays((shown) => (before ? [...shown, ...page.days.filter((day) => !shown.some((other) => other.date === day.date))] : page.days))
      setMore(page.more)
      setProblem(null)
    } catch (error) {
      if (current === round.current) setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      if (current === round.current) setLoading(false)
    }
  }, [])

  // The first page, again when the tag or the year changes.
  useEffect(() => {
    const current = ++round.current
    setDays([])
    setMore(false)
    void load(undefined, tag, current, year)
  }, [tag, year, load])

  // The search, once typing rests.
  useEffect(() => {
    if (!query) {
      setFound(null)
      setSearching(false)
      return
    }
    setSearching(true)
    let alive = true
    const timer = window.setTimeout(() => {
      journalApi.search(query).then(
        (result) => {
          if (!alive) return
          setFound(result)
          setProblem(null)
          setSearching(false)
        },
        (error) => {
          if (!alive) return
          setProblem(error instanceof ApiError ? error.code : 'internal_error')
          setSearching(false)
        },
      )
    }, SEARCH_PAUSE_MS)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [query])

  const next = useCallback(() => {
    if (loading || !more || query) return
    void load(days.at(-1)?.date, tag, round.current, year)
  }, [loading, more, query, days, tag, year, load])

  // The next page when the end of the list comes into view.
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const target = end.current
    if (!target || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && next(), { rootMargin: '600px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [next])

  const list: Shown[] = useMemo(() => {
    if (!query) return days
    if (!found) return []
    const entries = searchEntries(found).filter((entry) => !year || entry.date.startsWith(`${year}-`))
    return tag ? entries.filter((entry) => entry.tags.includes(tag)) : entries
  }, [query, found, days, tag, year])

  const since = overview?.since ? new Intl.DateTimeFormat(i18n.language, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${overview.since}T12:00:00Z`)) : ''
  const empty = overview?.count === 0
  const settled = query ? found !== null && !searching : !loading

  return (
    <div className="page pb-28 lg:pb-12">
      <header className="flex items-end justify-between gap-4 pt-8 pb-5">
        <div className="min-w-0">
          <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t('journal.title')}</h1>
          {overview && overview.count > 0 && <p className="mt-1 text-ink-2">{t('journal.count', { count: overview.count, since })}</p>}
        </div>
        {!empty && <LookSwitch look={look} />}
      </header>
      {overview?.volumes && overview.volumes.length > 0 && (
        <div className="mb-6">
          <Shelf volumes={overview.volumes} thisYear={overview.year ?? new Date().getFullYear()} daysLeft={overview.days_left ?? 0} year={year} onYear={setYear} name={me?.display_name || me?.name || ''} />
        </div>
      )}
      {!query && <CatchUpCard data={catchUp} className="mb-5" />}
      {empty ? (
        <div className="card p-8 text-center text-ink-2">
          <p>{t('journal.empty')}</p>
          <Link to="/" className="mt-4 inline-flex h-11 items-center rounded-full bg-accent px-5 font-semibold text-accent-ink shadow-soft hover:brightness-105">
            {t('journal.toToday')}
          </Link>
        </div>
      ) : (
        <>
          <div className="sticky top-0 z-20 -mx-4 mb-6 space-y-3 bg-paper/90 px-4 py-3 backdrop-blur lg:-mx-8 lg:px-8">
            <label className="card flex items-center gap-3 px-4 py-2.5">
              <Search size={18} className="text-muted" aria-hidden />
              <input
                value={q}
                maxLength={100}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('journal.search')}
                aria-label={t('journal.search')}
                type="search"
                className="flex-1 bg-transparent text-ink placeholder:text-muted focus:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
              {query && found && !searching && <span className="text-sm whitespace-nowrap text-muted">{found.more ? t('journal.hitsMore', { count: list.length }) : t('journal.hits', { count: list.length })}</span>}
            </label>
            {overview && overview.tags.length > 0 && (
              <div className="scroll-x flex gap-2 overflow-x-auto" role="group" aria-label={t('journal.tagFilter')}>
                <Chip active={!tag} onClick={() => setTag(null)}>
                  {t('journal.all')}
                </Chip>
                {overview.tags.map(({ tag: name, count }) => (
                  <Chip key={name} active={tag === name} onClick={() => setTag(tag === name ? null : name)}>
                    {name} <span className="opacity-60">{count}</span>
                  </Chip>
                ))}
              </div>
            )}
          </div>
          {problem && <p className="mb-4 text-center text-sm text-bad">{errorText(problem)}</p>}
          {settled && list.length === 0 && !problem && <p className="py-16 text-center text-muted">{t('journal.nothing')}</p>}
          {look === 'blog' ? <BlogGrid list={list} q={query} /> : <TimelineList list={list} q={query} />}
          <div ref={end} />
          {!query && more && (
            <div className="mt-8 flex justify-center">
              <button type="button" onClick={next} disabled={loading} className="h-11 rounded-full border border-line px-5 font-semibold text-ink-2 hover:bg-sheet-2 disabled:opacity-60">
                {loading ? t('journal.loading') : t('journal.more')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function href(e: Shown): string {
  return e.onlyNotes ? `/tag/${e.date}/schreiben` : `/tag/${e.date}`
}

function titleOf(e: Shown, t: (key: string) => string): string {
  if (e.onlyNotes) return t('journal.onlyNotes')
  if (e.unreadable) return t('journal.unreadable')
  return e.title || t('journal.untitled')
}

function Meta({ e }: { e: Shown }) {
  const { t } = useTranslation()
  const value = e.first_value
  return (
    <div className="flex items-center gap-3 text-xs font-semibold text-muted">
      {value && (
        <span className="inline-flex items-center gap-1" title={value.name}>
          <span className="h-2 w-2 rounded-full bg-accent" style={{ opacity: 0.25 + value.value / 13 }} /> {value.value}/10
        </span>
      )}
      {e.written_by === 'ai' && <Sparkles size={12} aria-label={t('journal.ai')} />}
      {e.locked && (
        <span className="inline-flex items-center gap-1" title={t('lock.badge')} data-locked-mark>
          <Lock size={12} aria-hidden /> <span className="sr-only">{t('lock.badge')}</span>
        </span>
      )}
      {e.shared_with.length > 0 && (
        <span className="inline-flex items-center gap-1">
          <Users size={12} aria-hidden /> {t('journal.shared')}
        </span>
      )}
    </div>
  )
}

function Picture({ e, className }: { e: Shown; className: string }) {
  if (!e.cover) return <span className={`block bg-sheet-2 ${className}`} />
  return <CoverImage cover={e.cover} crop={e.cover_crop} className={className} />
}

function BlogGrid({ list, q }: { list: Shown[]; q: string }) {
  const { t, i18n } = useTranslation()
  const [first, ...rest] = list
  if (!first) return null
  return (
    <div className="space-y-6">
      <Link to={href(first)} className="card group block overflow-hidden md:grid md:grid-cols-[1.2fr_1fr]">
        <Picture e={first} className="aspect-[16/10] h-full w-full" />
        <div className="flex flex-col justify-center p-6 sm:p-8">
          <p className="text-sm font-semibold tracking-wide text-muted uppercase">{longDate(first.date, i18n.language)}</p>
          <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight group-hover:text-accent sm:text-3xl">{mark(titleOf(first, t), q)}</h2>
          <p className="mt-3 line-clamp-4 font-serif leading-relaxed text-ink-2">{mark(first.excerpt, q)}</p>
          <div className="mt-4">
            <Meta e={first} />
          </div>
        </div>
      </Link>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {rest.map((e) => (
          <Link key={e.date} to={href(e)} className="card group flex flex-col overflow-hidden">
            <Picture e={e} className="aspect-[16/9] w-full" />
            <div className="flex flex-1 flex-col p-5">
              <p className="text-xs font-semibold tracking-wide text-muted uppercase">{longDate(e.date, i18n.language)}</p>
              <h3 className="mt-1 font-display text-xl font-semibold group-hover:text-accent">{mark(titleOf(e, t), q)}</h3>
              <p className="mt-2 line-clamp-3 flex-1 font-serif text-[0.95rem] leading-relaxed text-ink-2">{mark(e.excerpt, q)}</p>
              <div className="mt-3 flex items-center justify-between">
                <Meta e={e} />
                {e.shared_with[0] && <Avatar person={e.shared_with[0]} size={22} />}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}

function TimelineList({ list, q }: { list: Shown[]; q: string }) {
  const { t, i18n } = useTranslation()
  const monthOf = new Intl.DateTimeFormat(i18n.language, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const weekdayOf = new Intl.DateTimeFormat(i18n.language, { weekday: 'short', timeZone: 'UTC' })
  const groups: [string, Shown[]][] = []
  for (const e of list) {
    const key = monthOf.format(new Date(`${e.date}T12:00:00Z`))
    const group = groups.find((item) => item[0] === key)
    if (group) group[1].push(e)
    else groups.push([key, [e]])
  }
  return (
    <div className="space-y-10">
      {groups.map(([month, items]) => (
        <section key={month}>
          <h2 className="mb-3 font-display text-xl font-semibold text-ink-2">{month}</h2>
          <div className="card divide-y divide-line overflow-hidden">
            {items.map((e) => {
              const moment = new Date(`${e.date}T12:00:00Z`)
              return (
                <Link key={e.date} to={href(e)} className="group flex items-center gap-4 px-4 py-4 hover:bg-sheet-2/50 sm:px-5">
                  <div className="w-12 shrink-0 text-center">
                    <div className="font-display text-2xl leading-none font-semibold text-accent">{moment.getUTCDate()}</div>
                    <div className="mt-1 text-[0.7rem] font-bold text-muted uppercase">{weekdayOf.format(moment).slice(0, 2)}</div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-display text-lg font-semibold group-hover:text-accent">{mark(titleOf(e, t), q)}</h3>
                    <p className="truncate font-serif text-sm text-ink-2">{mark(e.excerpt, q)}</p>
                    <div className="mt-1.5 flex items-center gap-3">
                      <Meta e={e} />
                      <span className="hidden gap-1.5 text-xs text-muted sm:flex">
                        {e.tags.map((name) => (
                          <span key={name}>#{name}</span>
                        ))}
                      </span>
                    </div>
                  </div>
                  <Picture e={e} className="h-16 w-20 shrink-0 rounded-lg sm:w-24" />
                </Link>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
