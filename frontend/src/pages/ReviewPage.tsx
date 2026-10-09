/**
 * Looking back, as the mock's `ReviewPage.tsx`: a week as a strip of covers, a month as a collage, the tiles, the line
 * of the main value per day, the best day and what it was about. The server works it all out from the own pages
 * (`/api/review/<kind>`); this page draws it. The summary comes only on a press of the button, and only when the AI is
 * there for the person; it is shown and never kept.
 *
 * Addresses: `/rueckblick/woche` and `/rueckblick/monat` for the last one that is over, `/rueckblick/woche/<Monday>`
 * and `/rueckblick/monat/<1st>` for an earlier one.
 */
import { ChevronLeft, ChevronRight, Loader2, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { ApiError, type AiState } from '../api/client'
import { reviewApi, type Review, type ReviewDay, type ReviewKind } from '../api/review'
import { CoverImage } from '../covers/Cover'
import { MESSAGES_URL, PROVIDER_NAME } from '../lib/aiProviders'
import { longDate, monthName, weekdayOf, weekdayShort } from '../lib/dates'
import { errorText } from '../lib/errors'
import { useAiState } from '../state/ai'

const KIND: Record<string, ReviewKind> = { woche: 'week', monat: 'month' }
const PATH: Record<ReviewKind, string> = { week: 'woche', month: 'monat' }

export function ReviewPage() {
  const { t, i18n } = useTranslation()
  const params = useParams()
  const navigate = useNavigate()
  const kind = KIND[params.kind ?? ''] ?? 'week'
  const month = kind === 'month'
  const start = params.start ?? ''
  const [data, setData] = useState<Review | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const ai = useAiState()

  useEffect(() => {
    let alive = true
    setData(null)
    setProblem(null)
    reviewApi.get(kind, start || undefined).then(
      (found) => alive && setData(found),
      (error) => alive && setProblem(error instanceof ApiError ? error.code : 'internal_error'),
    )
    return () => {
      alive = false
    }
  }, [kind, start])

  const go = (target: string | null) => target && navigate(`/rueckblick/${PATH[kind]}/${target}`)
  const lang = i18n.language
  const dayMonth = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', timeZone: 'UTC' })
  const asDate = (day: string) => new Date(`${day}T12:00:00Z`)
  const span = data ? (month ? monthName(data.start, lang, true) : t('review.span', { from: dayMonth.format(asDate(data.start)), to: dayMonth.format(asDate(data.end)) })) : ''
  const heading = data && month ? t('review.yourMonth', { month: monthName(data.start, lang) }) : month ? t('review.month') : t('review.yourWeek')

  return (
    <div className="page space-y-6 pt-8 pb-28 lg:pb-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="min-h-5 text-sm font-semibold tracking-wide text-muted uppercase">{span}</p>
          <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{heading}</h1>
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label={t('review.kind')} className="flex rounded-full bg-sheet-2 p-1 text-sm font-semibold">
            {(['week', 'month'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={k === kind}
                onClick={() => navigate(`/rueckblick/${PATH[k]}`)}
                className={`rounded-full px-3.5 py-1 ${k === kind ? 'bg-sheet text-ink shadow-sm' : 'text-muted'}`}
              >
                {k === 'week' ? t('review.week') : t('review.month')}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => go(data?.prev ?? null)} disabled={!data?.prev} className="rounded-full p-2 text-muted hover:bg-sheet-2 disabled:text-muted/40 disabled:hover:bg-transparent" aria-label={t('review.before')}>
            <ChevronLeft size={18} />
          </button>
          <button type="button" onClick={() => go(data?.next ?? null)} disabled={!data?.next} className="rounded-full p-2 text-muted hover:bg-sheet-2 disabled:text-muted/40 disabled:hover:bg-transparent" aria-label={t('review.after')}>
            <ChevronRight size={18} />
          </button>
        </div>
      </header>

      {problem && <p className="text-sm text-bad">{errorText(problem)}</p>}
      {!data && !problem && <p className="text-sm text-muted">{t('review.loading')}</p>}
      {data && <Body data={data} ai={ai} />}
    </div>
  )
}

function Body({ data, ai }: { data: Review; ai: AiState | null }) {
  const { t, i18n } = useTranslation()
  const month = data.kind === 'month'
  const lang = i18n.language
  const decimal = new Intl.NumberFormat(lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const value = data.value
  const meanSmall = !value
    ? t('review.noValueShort')
    : data.mean_before === null
      ? t('review.mean', { name: value.name })
      : month
        ? t('review.meanMonth', { name: value.name, month: monthName(previousMonth(data.start), lang), before: decimal.format(data.mean_before) })
        : t('review.meanWeek', { name: value.name, before: decimal.format(data.mean_before) })
  return (
    <>
      {month ? <Collage days={data.days} /> : <Strip days={data.days} />}

      {data.unreadable > 0 && <p className="text-sm text-muted">{t('review.unreadable', { count: data.unreadable })}</p>}
      {data.written === 0 && <p className="text-sm text-muted">{month ? t('review.nothingMonth') : t('review.nothingWeek')}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Num big={`${data.written}`} small={t('review.written', { total: data.total })} />
        <Num big={data.mean === null ? t('review.none') : decimal.format(data.mean)} small={meanSmall} />
        <Num big={data.words.toLocaleString(lang)} small={t('review.words')} />
        <Num big={data.photos.toLocaleString(lang)} small={t('review.photos')} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr] lg:items-start">
        <section className="card p-5">
          <h2 className="font-display text-lg font-semibold">{value?.name ?? t('review.lineTitle')}</h2>
          {value ? data.days.some((day) => day.value !== null) ? <ValueLine days={data.days} month={month} name={value.name} /> : <p className="mt-2 text-sm text-muted">{t('review.noRating', { name: value.name })}</p> : <p className="mt-2 text-sm text-muted">{t('review.noValue')}</p>}
        </section>
        {data.best && value && (
          <Link to={`/tag/${data.best.date}`} className="card group overflow-hidden" data-best>
            <CoverImage cover={data.best.cover} crop={data.best.cover_crop} className="aspect-[16/8] w-full" />
            <div className="p-5">
              <p className="text-xs font-bold tracking-wide text-accent uppercase">{month ? t('review.bestMonth') : t('review.bestWeek')}</p>
              <h3 className="mt-1 font-display text-xl font-semibold group-hover:text-accent">{data.best.title || t('journal.untitled')}</h3>
              <p className="mt-0.5 text-sm text-muted">
                {longDate(data.best.date, lang)} · {t('review.bestValue', { name: value.name, value: data.best.value })}
              </p>
            </div>
          </Link>
        )}
      </div>

      {data.tags.length > 0 && (
        <section className="card p-5">
          <h2 className="mb-3 font-display text-lg font-semibold">{t('review.about')}</h2>
          <div className="flex flex-wrap gap-2">
            {data.tags.map(({ tag, count }) => (
              <span key={tag} className="rounded-full bg-accent-soft px-3 py-1 text-sm font-semibold text-accent">
                #{tag} <span className="opacity-60">{count}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {ai?.available && data.written > 0 && <Summary key={`${data.kind}${data.start}`} data={data} ai={ai} />}
    </>
  )
}

function previousMonth(start: string): string {
  const [year, month] = start.split('-').map(Number)
  return month === 1 ? `${year - 1}-12-01` : `${year}-${String(month - 1).padStart(2, '0')}-01`
}

function Num({ big, small }: { big: string; small: string }) {
  return (
    <div className="card px-4 py-4">
      <div className="font-display text-3xl font-semibold text-accent">{big}</div>
      <div className="mt-0.5 text-xs font-semibold text-muted">{small}</div>
    </div>
  )
}

function dayLabel(day: string, lang: string): string {
  return `${weekdayShort(weekdayOf(day), lang).slice(0, 2)} ${Number(day.slice(8, 10))}.`
}

function Strip({ days }: { days: ReviewDay[] }) {
  const { t, i18n } = useTranslation()
  return (
    <div className="scroll-x -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-7 sm:px-0" data-strip>
      {days.map((day) =>
        day.page ? (
          <Link key={day.date} to={`/tag/${day.date}`} className="card group w-36 shrink-0 snap-start overflow-hidden sm:w-auto">
            <CoverImage cover={day.page.cover} crop={day.page.cover_crop} className="aspect-[3/4] w-full" />
            <div className="p-2.5">
              <p className="text-[0.7rem] font-bold text-muted uppercase">{dayLabel(day.date, i18n.language)}</p>
              <p className="line-clamp-2 text-sm leading-snug font-semibold group-hover:text-accent">{day.page.unreadable ? t('journal.unreadable') : day.page.title || t('journal.untitled')}</p>
            </div>
          </Link>
        ) : (
          <div key={day.date} className="flex w-36 shrink-0 snap-start flex-col items-center justify-center rounded-[1.25rem] border-2 border-dashed border-line p-3 text-center text-sm text-muted sm:w-auto" data-free>
            <span className="text-[0.7rem] font-bold uppercase">{dayLabel(day.date, i18n.language)}</span>
            {t('review.free')}
          </div>
        ),
      )}
    </div>
  )
}

function Collage({ days }: { days: ReviewDay[] }) {
  const { t, i18n } = useTranslation()
  const lead = weekdayOf(days[0].date)
  return (
    <section className="card p-3 sm:p-4" data-collage>
      <div className="mb-2 grid grid-cols-7 gap-1.5 text-center text-[0.7rem] font-bold text-muted uppercase">
        {[0, 1, 2, 3, 4, 5, 6].map((index) => (
          <span key={index}>{weekdayShort(index, i18n.language).slice(0, 2)}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {Array.from({ length: lead }, (_, index) => (
          <span key={`l${index}`} />
        ))}
        {days.map((day) =>
          day.page ? (
            <Link key={day.date} to={`/tag/${day.date}`} className="relative overflow-hidden rounded-lg transition hover:-translate-y-0.5" title={day.page.title || t('journal.untitled')}>
              <CoverImage cover={day.page.cover} crop={day.page.cover_crop} className="aspect-square w-full" />
              <span className="absolute top-1 left-1.5 text-[0.7rem] font-bold text-white drop-shadow">{Number(day.date.slice(8, 10))}</span>
            </Link>
          ) : (
            <span key={day.date} className="flex aspect-square items-start rounded-lg bg-sheet-2 p-1.5 text-[0.7rem] font-bold text-muted">
              {Number(day.date.slice(8, 10))}
            </span>
          ),
        )}
      </div>
    </section>
  )
}

function ValueLine({ days, month, name }: { days: ReviewDay[]; month: boolean; name: string }) {
  const { t, i18n } = useTranslation()
  const W = 600
  const H = 160
  const x = (i: number) => 16 + (i * (W - 32)) / Math.max(1, days.length - 1)
  const y = (v: number) => H - 16 - ((v - 1) / 9) * (H - 32)
  const points = days.map((day, i) => ({ i, v: day.value })).filter((p): p is { i: number; v: number } => p.v !== null)
  const path = points.map((p, k) => `${k ? 'L' : 'M'}${x(p.i)},${y(p.v)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H + 18}`} className="mt-3 w-full" role="img" aria-label={t('review.lineLabel', { name })}>
      {[1, 5, 10].map((v) => (
        <g key={v}>
          <line x1={16} x2={W - 16} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeDasharray={v === 5 ? '0' : '3 4'} />
          <text x={0} y={y(v) + 4} fontSize="10" fill="var(--muted)">
            {v}
          </text>
        </g>
      ))}
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p) => (
        <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={month ? 3 : 5} fill="var(--sheet)" stroke="var(--accent)" strokeWidth="2.5">
          <title>
            {longDate(days[p.i].date, i18n.language)}: {p.v}/10
          </title>
        </circle>
      ))}
      {!month &&
        days.map((day, i) => (
          <text key={day.date} x={x(i)} y={H + 14} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--muted)">
            {weekdayShort(weekdayOf(day.date), i18n.language).slice(0, 2)}
          </text>
        ))}
    </svg>
  )
}

/** Where the pages go when the AI sums them up, said before the button. */
function whereTo(ai: AiState, month: boolean, t: (key: string, values?: Record<string, unknown>) => string): string {
  if (ai.provider === 'local') return t('review.aiLocal')
  const named = ai.provider === 'messages' && ai.to === new URL(MESSAGES_URL).hostname ? PROVIDER_NAME.messages : undefined
  return t(month ? 'review.aiToMonth' : 'review.aiToWeek', { name: named ?? ai.to })
}

function Summary({ data, ai }: { data: Review; ai: AiState }) {
  const { t, i18n } = useTranslation()
  const month = data.kind === 'month'
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const sum = async () => {
    if (state === 'busy') return
    setState('busy')
    setProblem(null)
    try {
      const found = await reviewApi.summary(data.kind, data.start)
      setText(found.text)
      setState('done')
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'internal_error'
      setProblem(i18n.exists(`review.errors.${code}`) ? t(`review.errors.${code}`) : errorText(code, error instanceof ApiError ? error.values : {}))
      setState('idle')
    }
  }
  return (
    <section className="card overflow-hidden" data-summary>
      <div className="flex flex-wrap items-center justify-between gap-3 bg-accent-soft/70 px-5 py-4">
        <div>
          <h2 className="font-display text-lg font-semibold">{month ? t('review.summaryMonth') : t('review.summaryWeek')}</h2>
          <p className="text-sm text-ink-2">{t('review.summaryText')}</p>
        </div>
        {state !== 'done' && (
          <button
            type="button"
            onClick={() => void sum()}
            disabled={state === 'busy'}
            className="inline-flex h-8 items-center justify-center gap-2 rounded-full bg-accent px-3.5 text-sm font-semibold text-accent-ink shadow-soft transition hover:brightness-105 disabled:pointer-events-none disabled:opacity-50"
          >
            {state === 'busy' ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} {t('review.summarize')}
          </button>
        )}
      </div>
      <div className="p-5">
        {state === 'done' ? (
          <div className="space-y-3 font-serif text-[1.05rem] leading-relaxed text-ink">
            {text.split(/\n{2,}/).map((part, index) => (
              <p key={index}>{part}</p>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">{whereTo(ai, month, t)}</p>
        )}
        {problem && <p className="mt-2 text-sm text-bad">{problem}</p>}
      </div>
    </section>
  )
}

