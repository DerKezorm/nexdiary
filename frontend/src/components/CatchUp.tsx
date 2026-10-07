/**
 * Days with notes and no page, the last sixty: a quiet card on "Today" and a section in the journal. Folded away it says
 * how many; opened it lists each day with its date, how many notes and the start of the first, and "Aufschreiben" leads
 * to the writing view of that day (where the AI button stands, when there is one).
 */
import { ChevronDown, PenLine, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import type { CatchUp } from '../api/client'
import { addDays, longDate } from '../lib/dates'

/** The morning writing made a draft that waits: a card on "Today" that leads to it. Reading and taking it is the
 * person's; until then the day is no page. `today` is the day being kept. */
export function AutoDraftCard({ data, today }: { data: CatchUp | undefined | null; today: string }) {
  const { t, i18n } = useTranslation()
  const waiting = data?.days.find((day) => day.auto)
  if (!data || !waiting) return null
  const yesterday = waiting.date === addDays(today, -1)
  return (
    <section className="card flex flex-wrap items-center gap-3 px-5 py-4" aria-label={t('autowrite.waiting')} data-auto-draft-card>
      <Sparkles size={19} className="shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{yesterday ? t('autowrite.cardYesterday') : t('autowrite.cardDay', { date: longDate(waiting.date, i18n.language) })}</span>
        <span className="block text-sm text-muted">{data.auto && data.auto > 1 ? t('autowrite.cardMore', { count: data.auto - 1 }) : t('autowrite.cardText')}</span>
      </span>
      <Link to={`/tag/${waiting.date}/schreiben`} className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink shadow-soft transition hover:brightness-105">
        <PenLine size={14} aria-hidden /> {t('autowrite.look')}
      </Link>
    </section>
  )
}

export function CatchUpCard({ data, open: startOpen = false, className = '' }: { data: CatchUp | undefined | null; open?: boolean; className?: string }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(startOpen)
  if (!data || data.count === 0) return null
  return (
    <section className={`card px-5 py-4 ${className}`} aria-label={t('catchUp.title', { count: data.count })} data-catch-up>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 text-left">
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">{t('catchUp.title', { count: data.count })}</span>
          <span className="block text-sm text-muted">{t('catchUp.text')}</span>
        </span>
        <span className="inline-flex items-center gap-1 text-sm font-semibold text-accent">
          {open ? t('catchUp.hide') : t('catchUp.show')} <ChevronDown size={16} className={open ? 'rotate-180' : ''} aria-hidden />
        </span>
      </button>
      {open && (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {data.days.map((day) => (
            <li key={day.date} className="flex items-center gap-3 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">
                  {longDate(day.date, i18n.language)} <span className="font-normal text-muted">· {t('catchUp.notes', { count: day.notes })}</span>
                </span>
                {day.auto && (
                  <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-accent">
                    <Sparkles size={12} aria-hidden /> {t('autowrite.mark')}
                  </span>
                )}
                {day.start && <span className="mt-0.5 block truncate font-serif text-sm text-ink-2">{day.start}</span>}
              </span>
              <Link to={`/tag/${day.date}/schreiben`} className="inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-full bg-accent-soft px-3.5 text-sm font-semibold text-accent transition hover:brightness-[0.98]">
                <PenLine size={14} aria-hidden /> {day.auto ? t('autowrite.look') : t('catchUp.write')}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
