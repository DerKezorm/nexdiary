/**
 * The statistics, as the mock's `StatsPage.tsx`: streaks first (they keep people writing), then the year as a calendar,
 * one value over time, the best and the worst day, the weekdays, what goes together, the tags and how the pages come
 * about. Everything is worked out by the server from the own days only; this page draws it. The value most of it is
 * about is the first one the person asks for, under whatever name they gave it.
 */
import { BookOpen, CalendarDays, Flame, Heart, Image, PenLine, Sparkles, Trophy } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { ApiError, statsApi, type Stats, type StatsDay, type StatsExtremes, type StatsRange, type StatsSpan, type StatsValue } from '../api/client'
import { YearAgo } from '../components/YearAgo'
import { CoverImage } from '../covers/Cover'
import { addDays, longDate, monthName, weekdayName } from '../lib/dates'
import { errorText } from '../lib/errors'
import { Segment } from './settings/ui'

const WEEKDAY_KEYS = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as const

function Tile({ icon: Icon, label, value, sub }: { icon: typeof Flame; label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-muted">
        <Icon size={16} className="text-accent" aria-hidden /> {label}
      </div>
      <div className="mt-2 font-display text-4xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  )
}

function Panel({ title, text, extra, children }: { title: string; text?: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold">{title}</h2>
          {text && <p className="text-sm text-ink-2">{text}</p>}
        </div>
        {extra}
      </div>
      {children}
    </section>
  )
}

/** One decimal in the language of the page ("7,5"), a dash for nothing. */
function useFormat() {
  const { i18n } = useTranslation()
  const one = new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return {
    decimal: (n: number | null) => (n === null ? '–' : one.format(n)),
    whole: (n: number) => n.toLocaleString(i18n.language),
  }
}

export function StatsPage() {
  const { t, i18n } = useTranslation()
  const [data, setData] = useState<Stats | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const format = useFormat()

  useEffect(() => {
    let live = true
    statsApi.get().then(
      (found) => live && setData(found),
      (error) => live && setProblem(error instanceof ApiError ? error.code : 'internal_error'),
    )
    return () => {
      live = false
    }
  }, [])

  const head = (
    <header>
      <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t('stats.title')}</h1>
      <p className="mt-1 text-ink-2">{t('stats.intro')}</p>
    </header>
  )
  if (!data)
    return (
      <div className="page space-y-6 pt-8 pb-28 lg:pb-12">
        {head}
        {problem ? <p className="text-sm text-bad">{errorText(problem)}</p> : <p className="text-sm text-muted">{t('stats.loading')}</p>}
      </div>
    )

  const { tiles } = data
  const longestSub = tiles.longest === 0 ? undefined : tiles.current === tiles.longest ? t('stats.tiles.stillOn') : t('stats.tiles.longestIn', { month: monthName(tiles.longest_end ?? data.today, i18n.language, (tiles.longest_end ?? data.today).slice(0, 4) !== data.today.slice(0, 4)) })

  return (
    <div className="page space-y-6 pt-8 pb-28 lg:pb-12">
      {head}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile icon={Flame} label={t('stats.tiles.streak')} value={t('stats.tiles.days', { count: tiles.current })} sub={tiles.today_done ? t('stats.tiles.todayDone') : t('stats.tiles.todayOpen')} />
        <Tile icon={Trophy} label={t('stats.tiles.longest')} value={t('stats.tiles.days', { count: tiles.longest })} sub={longestSub} />
        <Tile icon={CalendarDays} label={t('stats.tiles.daysYear', { year: tiles.year })} value={format.whole(tiles.days_year)} sub={t('stats.tiles.inTotal', { count: tiles.days_total })} />
        <Tile icon={BookOpen} label={t('stats.tiles.words')} value={format.whole(tiles.words)} sub={t('stats.tiles.perDay', { count: tiles.words_per_day })} />
      </div>

      {data.unreadable > 0 && <p className="text-sm text-muted">{t('stats.unreadable', { count: data.unreadable })}</p>}

      {data.pages === 0 ? (
        <div className="card p-6 text-ink-2">{t('stats.empty')}</div>
      ) : (
        <>
          <YearCalendar data={data} />
          <ValueOverTime data={data} />
          <BestWorst data={data} />

          <div className="grid items-start gap-6 lg:grid-cols-2">
            <Weekdays data={data} />
            <Together data={data} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Tags data={data} />
            <Panel title={t('stats.writing.title')} text={t('stats.writing.text')}>
              <WritingSplit writing={data.writing} />
            </Panel>
          </div>

          {data.year_ago && <YearAgo day={data.year_ago} roomy />}
        </>
      )}
    </div>
  )
}

/** What a panel says while no value is asked for, or while there are too few days with one. */
function Hint({ value, thin }: { value: StatsValue | null; thin?: string }) {
  const { t } = useTranslation()
  return <p className="text-sm text-muted">{value ? (thin ?? t('stats.needValue', { name: value.name })) : t('stats.noValue')}</p>
}

// --- the year as a calendar: one square per day, darker for a higher value ----------------------------------------------

function YearCalendar({ data }: { data: Stats }) {
  const { t, i18n } = useTranslation()
  const value = data.value
  const [mode, setMode] = useState<'value' | 'written'>(value ? 'value' : 'written')
  const [hover, setHover] = useState<{ date: string; x: number; y: number } | null>(null)
  const { calendar, today } = data
  const byDate = new Map(calendar.days.map((day) => [day.date, day]))
  const cell = 15
  const gap = 3
  const left = 26
  const top = 18
  const cols = Array.from({ length: calendar.weeks }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(calendar.start, w * 7 + d)))
  const level = (date: string) => {
    const day = byDate.get(date)
    if (!day) return 0
    if (mode === 'written') return day.written ? 4 : 0
    const v = day.value
    if (v === null) return day.written ? 1 : 0
    return v <= 3 ? 1 : v <= 5 ? 2 : v <= 7 ? 3 : 4
  }
  const opacity = [0, 0.25, 0.45, 0.7, 1]
  const width = left + calendar.weeks * (cell + gap)
  const hovered = hover ? byDate.get(hover.date) : undefined
  // On a narrow screen the calendar scrolls sideways inside its card; it opens at today, not half a year ago.
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (box.current) box.current.scrollLeft = box.current.scrollWidth
  }, [])
  const show = (date: string, target: SVGRectElement) => {
    const svg = target.ownerSVGElement as SVGSVGElement
    const r = svg.getBoundingClientRect()
    const c = target.getBoundingClientRect()
    // Measured in the page, drawn in the card; kept inside the card so that a square at its edge shows its tooltip.
    setHover({ date, x: Math.max(90, Math.min(c.left - r.left + c.width / 2, r.width - 90)), y: c.top - r.top })
  }
  const labels = ['mo', 'we', 'fr'] as const
  return (
    <Panel
      title={t('stats.calendar.title')}
      text={mode === 'value' && value ? t('stats.calendar.textValue', { name: value.name }) : t('stats.calendar.textWritten')}
      extra={
        value && (
          <Segment
            value={mode}
            onChange={setMode}
            options={[
              { value: 'value', label: value.name },
              { value: 'written', label: t('stats.calendar.written') },
            ]}
          />
        )
      }
    >
      <div ref={box} className="relative overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${top + 7 * (cell + gap)}`} className="w-full min-w-[30rem]" role="img" aria-label={t('stats.calendar.label', { count: calendar.weeks })}>
          {cols.map((days, w) => {
            const first = days[0]
            return Number(first.slice(8, 10)) <= 7 ? (
              <text key={`m${w}`} x={left + w * (cell + gap)} y={11} className="fill-[var(--muted)] text-[9px] font-semibold">
                {monthName(first, i18n.language).slice(0, 3)}
              </text>
            ) : null
          })}
          {labels.map((key, i) => (
            <text key={key} x={0} y={top + (i * 2 + 1) * (cell + gap) - 4} className="fill-[var(--muted)] text-[9px]">
              {t(`stats.weekdayShort.${key}`)}
            </text>
          ))}
          {cols.map((days, w) =>
            days.map((date, d) => {
              if (date > today) return null
              const l = level(date)
              return (
                <rect
                  key={date}
                  x={left + w * (cell + gap)}
                  y={top + d * (cell + gap)}
                  width={cell}
                  height={cell}
                  rx={3.5}
                  fill={l ? 'var(--accent)' : 'var(--sheet-2)'}
                  fillOpacity={l ? opacity[l] : 1}
                  stroke={date === today ? 'var(--ink)' : 'none'}
                  strokeWidth={1.5}
                  data-date={date}
                  onMouseEnter={(ev) => show(date, ev.currentTarget)}
                  onMouseLeave={() => setHover(null)}
                  onClick={(ev) => (hover?.date === date ? setHover(null) : show(date, ev.currentTarget))}
                />
              )
            }),
          )}
        </svg>
        {hover && (
          <div
            role="status"
            className={`pointer-events-none absolute z-10 max-w-[16rem] -translate-x-1/2 rounded-lg bg-ink px-3 py-1.5 text-xs text-paper shadow-soft ${hover.y < 60 ? '' : '-translate-y-full'}`}
            style={{ left: hover.x, top: hover.y < 60 ? hover.y + cell + 6 : hover.y - 6 }}
          >
            <span className="font-semibold">{longDate(hover.date, i18n.language)}</span>
            <br />
            <span className="block truncate">
              {hovered
                ? `${hovered.title || t('journal.untitled')}${hovered.value !== null && value ? ` · ${t('stats.calendar.withValue', { name: value.name, value: hovered.value })}` : ''}`
                : t('stats.calendar.nothingWritten')}
            </span>
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-xs text-muted">
        {mode === 'value' && value ? value.low || '1' : t('stats.calendar.nothing')}
        {opacity.map((o, i) => (
          <span key={i} className="h-3 w-3 rounded-[3px]" style={{ background: i ? 'var(--accent)' : 'var(--sheet-2)', opacity: i ? o : 1 }} />
        ))}
        {mode === 'value' && value ? value.high || '10' : t('stats.calendar.legendWritten')}
      </div>
    </Panel>
  )
}

// --- one value over time: the days as dots, the mean of the week as a line ----------------------------------------------

function ValueOverTime({ data }: { data: Stats }) {
  const { t, i18n } = useTranslation()
  const format = useFormat()
  const [id, setId] = useState(data.value?.id ?? '')
  const [range, setRange] = useState<StatsRange>('90')
  const [hover, setHover] = useState<number | null>(null)
  const [narrow, setNarrow] = useState(() => window.innerWidth < 640)
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 640)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  const series = data.series.values[id]
  const found = data.values.find((v) => v.id === id)
  if (!series || !found)
    return (
      <Panel title={t('stats.series.titleNone')}>
        <Hint value={null} />
      </Panel>
    )
  const n = Number(range)
  const values = series.values.slice(-n)
  const means = series.means.slice(-n)
  const dateAt = (i: number) => addDays(data.series.end, i - n + 1)
  const W = narrow ? 360 : 720
  const H = narrow ? 240 : 220
  const pad = { l: 26, r: 8, t: 10, b: 24 }
  const x = (i: number) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - (v - 1) / 9) * (H - pad.t - pad.b)
  let d = ''
  means.forEach((v, i) => {
    if (v === null) return
    d += `${d && means[i - 1] !== null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`
  })
  const mean = series.mean[range]
  const at = hover !== null ? { date: dateAt(hover), value: values[hover], mean: means[hover] } : null
  const point = (clientX: number, svg: SVGSVGElement) => {
    const r = svg.getBoundingClientRect()
    const px = ((clientX - r.left) / r.width) * W
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1)))))
  }
  return (
    <Panel
      title={t('stats.series.title', { name: found.name })}
      text={mean === null ? t('stats.series.textNone') : t('stats.series.text', { mean: format.decimal(mean) })}
      extra={
        <div className="flex flex-wrap gap-2">
          <select
            value={id}
            onChange={(e) => setId(e.target.value)}
            aria-label={t('stats.series.pick')}
            className="h-9 rounded-full border border-line bg-sheet px-3 text-sm font-semibold text-ink"
          >
            {data.values.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <Segment
            value={range}
            onChange={setRange}
            options={[
              { value: '30', label: t('stats.series.range30') },
              { value: '90', label: t('stats.series.range90') },
              { value: '180', label: t('stats.series.range180') },
            ]}
          />
        </div>
      }
    >
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label={t('stats.series.label', { name: found.name, count: n })}
          onPointerMove={(e) => point(e.clientX, e.currentTarget)}
          onPointerDown={(e) => point(e.clientX, e.currentTarget)}
          // A finger that lifts leaves the tooltip standing; only a mouse that leaves takes it away.
          onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(null)}
        >
          {[1, 4, 7, 10].map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth={1} />
              <text x={0} y={y(v) + 3} className="fill-[var(--muted)] text-[10px]">
                {v}
              </text>
            </g>
          ))}
          {values.map((_, i) =>
            i % Math.ceil(n / (narrow ? 3 : 6)) === 0 ? (
              <text key={dateAt(i)} x={x(i)} y={H - 6} textAnchor="middle" className="fill-[var(--muted)] text-[10px]">
                {Number(dateAt(i).slice(8, 10))}. {monthName(dateAt(i), i18n.language).slice(0, 3)}
              </text>
            ) : null,
          )}
          {values.map((v, i) => (v === null ? null : <circle key={dateAt(i)} cx={x(i)} cy={y(v)} r={n > 100 ? 2.5 : 3.5} fill="var(--accent)" fillOpacity={0.3} />))}
          <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
          {at && hover !== null && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--ink)" strokeOpacity={0.25} />
              {at.value !== null && <circle cx={x(hover)} cy={y(at.value)} r={5} fill="var(--accent)" stroke="var(--sheet)" strokeWidth={2} />}
            </>
          )}
        </svg>
        {at && hover !== null && (
          <div
            role="status"
            className="pointer-events-none absolute top-0 rounded-lg bg-ink px-3 py-1.5 text-xs text-paper shadow-soft"
            style={{ left: `clamp(0px, calc(${(x(hover) / W) * 100}% - 70px), calc(100% - 150px))` }}
          >
            <span className="font-semibold">{longDate(at.date, i18n.language)}</span>
            <br />
            {at.value !== null ? `${found.name} ${at.value}` : t('stats.series.noValue')} · {t('stats.series.mean', { mean: format.decimal(at.mean) })}
          </div>
        )}
      </div>
    </Panel>
  )
}

// --- the weekdays: the value on average per day of the week ------------------------------------------------------------

function Weekdays({ data }: { data: Stats }) {
  const { t, i18n } = useTranslation()
  const format = useFormat()
  const value = data.value
  const [hover, setHover] = useState<number | null>(null)
  const { days, best } = data.weekdays
  return (
    <Panel title={t('stats.weekdays.title')} text={value ? t('stats.weekdays.text', { name: value.name }) : undefined}>
      {value && days.some((day) => day.n > 0) ? (
        <>
          <div className="flex h-44 items-end gap-2">
            {days.map((day, i) => (
              <div
                key={i}
                className="relative flex h-full flex-1 flex-col items-center justify-end gap-1.5"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={() => setHover(hover === i ? null : i)}
              >
                <span className={`text-xs font-bold tabular-nums ${hover === i || i === best ? 'text-ink' : 'text-muted'}`}>{format.decimal(day.mean)}</span>
                <div className="w-full max-w-12 rounded-t-[4px] bg-accent transition-opacity" style={{ height: `${((day.mean ?? 0) / 10) * 100}%`, opacity: i === best || hover === i ? 1 : 0.55 }} />
                <span className="text-xs font-semibold text-muted">{t(`stats.weekdayShort.${WEEKDAY_KEYS[i]}`)}</span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-ink-2">
            {best === null ? t('stats.weekdays.thin') : t('stats.weekdays.best', { name: value.name, day: weekdayName(best, i18n.language) })}
          </p>
        </>
      ) : (
        <Hint value={value} />
      )}
    </Panel>
  )
}

// --- what goes together: plain sentences instead of a correlation matrix -----------------------------------------------

function Together({ data }: { data: Stats }) {
  const { t } = useTranslation()
  const format = useFormat()
  const value = data.value
  const label = (row: Stats['together'][number]) => {
    if (row.kind === 'value') return { a: t('stats.together.highValue', { name: row.name }), b: t('stats.together.lowValue', { name: row.name }) }
    if (row.kind === 'weekend') return { a: t('stats.together.weekend'), b: t('stats.together.workdays') }
    return { a: t('stats.together.withTag', { tag: row.tag }), b: t('stats.together.without') }
  }
  return (
    <Panel title={t('stats.together.title')} text={value ? t('stats.together.text', { name: value.name }) : undefined}>
      {data.together.length === 0 ? (
        <Hint value={value} thin={t('stats.together.thin', { min: 5 })} />
      ) : (
        <ul className="space-y-3">
          {data.together.map((row) => {
            const { a, b } = label(row)
            const key = row.kind === 'value' ? `v:${row.name}` : row.kind === 'tag' ? `t:${row.tag}` : 'weekend'
            return (
              <li key={key} className="rounded-xl bg-sheet-2/60 px-4 py-3">
                <span className="sr-only">{t('stats.together.sentence', { a, aMean: format.decimal(row.a_mean), aDays: row.a_n, b, bMean: format.decimal(row.b_mean), bDays: row.b_n })}</span>
                <div className="flex items-baseline justify-between gap-3 text-sm" aria-hidden>
                  <span className="font-semibold">{a}</span>
                  <span className={`text-xs font-bold ${row.similar ? 'text-muted' : 'text-accent'}`}>
                    {row.similar ? t('stats.together.similar') : `${row.diff > 0 ? '+' : '−'}${format.decimal(Math.abs(row.diff))}`}
                  </span>
                </div>
                <div className="mt-2 space-y-1" aria-hidden>
                  {(
                    [
                      [t('stats.together.these'), row.a_mean, 1],
                      [b, row.b_mean, 0.4],
                    ] as const
                  ).map(([name, mean, o]) => (
                    <div key={name} className="flex items-center gap-2 text-xs">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-sheet">
                        <div className="h-full rounded-full bg-accent" style={{ width: `${(mean / 10) * 100}%`, opacity: o }} />
                      </div>
                      <span className="w-36 shrink-0 truncate text-right text-muted tabular-nums">
                        {name} {format.decimal(mean)}
                      </span>
                    </div>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">{t('stats.together.note')}</p>
    </Panel>
  )
}

function Tags({ data }: { data: Stats }) {
  const { t } = useTranslation()
  const max = data.tags[0]?.count ?? 1
  return (
    <Panel title={t('stats.tags.title')}>
      {data.tags.length === 0 ? (
        <p className="text-sm text-muted">{t('stats.tags.none')}</p>
      ) : (
        <ul className="space-y-2">
          {data.tags.map(({ tag, count }) => (
            <li key={tag} className="flex items-center gap-3 text-sm">
              <span className="w-24 truncate font-semibold">#{tag}</span>
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-sheet-2">
                <div className="h-full rounded-full bg-accent" style={{ width: `${(count / max) * 100}%` }} />
              </div>
              <span className="w-8 text-right text-muted tabular-nums">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function WritingSplit({ writing }: { writing: Stats['writing'] }) {
  const { t } = useTranslation()
  const rows = [
    { icon: Sparkles, label: t('stats.writing.ai'), n: writing.ai },
    { icon: PenLine, label: t('stats.writing.self'), n: writing.self },
    { icon: Image, label: t('stats.writing.photos'), n: writing.photos },
    { icon: Heart, label: t('stats.writing.shared'), n: writing.shared },
  ]
  return (
    <ul className="divide-y divide-line">
      {rows.map(({ icon: Icon, label, n }) => (
        <li key={label} className="flex items-center gap-3 py-2.5 text-sm">
          <Icon size={16} className="text-accent" aria-hidden />
          <span className="flex-1">{label}</span>
          <span className="font-bold tabular-nums">{n}</span>
          <span className="w-12 text-right text-xs text-muted tabular-nums">{writing.total ? Math.round((n / writing.total) * 100) : 0} %</span>
        </li>
      ))}
    </ul>
  )
}

// The best and the worst day by the value, in a chosen span. With equal ratings the more recent day counts (the server decides).
function BestWorst({ data }: { data: Stats }) {
  const { t, i18n } = useTranslation()
  const value = data.value
  const [span, setSpan] = useState<StatsSpan>('365')
  const found: StatsExtremes = data.extremes[span]
  const card = (day: StatsDay | null, label: string) =>
    day && value ? (
      <Link to={`/tag/${day.date}`} className="group overflow-hidden rounded-2xl border border-line bg-sheet-2/40 hover:border-accent">
        <div className="relative">
          <CoverImage cover={day.cover} className="aspect-[16/8] w-full" />
          <span className="absolute top-3 left-3 rounded-full bg-black/45 px-3 py-1 text-xs font-bold text-white backdrop-blur">{label}</span>
          <span className="absolute right-3 bottom-3 rounded-full bg-sheet px-3 py-1 text-sm font-bold text-ink">{t('stats.extremes.badge', { name: value.name, value: day.value })}</span>
        </div>
        <div className="p-4">
          <div className="text-xs font-semibold tracking-wide text-muted uppercase">{longDate(day.date, i18n.language, true)}</div>
          <div className="mt-0.5 font-display text-lg font-semibold group-hover:text-accent">{day.title || t('journal.untitled')}</div>
          <p className="mt-1 line-clamp-2 font-serif text-sm text-ink-2">{day.excerpt}</p>
        </div>
      </Link>
    ) : null
  return (
    <Panel
      title={t('stats.extremes.title')}
      text={value ? t('stats.extremes.text', { name: value.name }) : undefined}
      extra={
        <Segment
          value={span}
          onChange={setSpan}
          options={[
            { value: '30', label: t('stats.extremes.span30') },
            { value: '365', label: t('stats.extremes.span365') },
            { value: 'all', label: t('stats.extremes.spanAll') },
          ]}
        />
      }
    >
      {found.best && found.worst ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {card(found.best, t('stats.extremes.best'))}
          {card(found.worst, t('stats.extremes.worst'))}
        </div>
      ) : (
        <Hint value={value} />
      )}
    </Panel>
  )
}
