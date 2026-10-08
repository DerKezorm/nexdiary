/**
 * The streak next to the flame on "Today" and in the quick note (there in a row of its own under the header, a phone
 * is too narrow for it beside the date): its number in its unit (days at goal 7, weeks in a
 * row below), under a goal below 7 how many pages this week has against it, and a small shield with the number of
 * shields in hand (only while there is one). The server works all of it out.
 */
import { Flame, Shield } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { TodayData } from '../api/client'
import { seriesOf } from '../lib/streak'

export function StreakBadges({ data, compact = false }: { data: TodayData; compact?: boolean }) {
  const { t } = useTranslation()
  const series = seriesOf(data)
  const label = t(`today.series.label_${series.unit}`)
  const standing = series.goal < 7 ? t('today.series.week', { count: series.week.count, goal: series.goal }) : null
  const pill = compact ? 'gap-1 px-2.5 py-1 text-xs' : 'gap-1.5 px-3 py-1.5 text-sm'
  const size = compact ? 13 : 16
  return (
    <span className={compact ? 'flex flex-wrap items-center gap-x-2.5 gap-y-1' : 'flex flex-wrap items-center justify-end gap-2'} data-testid="streak">
      <span className="inline-flex items-center gap-1.5">
        <span className={`inline-flex items-center rounded-full bg-accent-soft font-bold text-accent ${pill}`} title={label}>
          <Flame size={size} aria-hidden /> <span className="sr-only">{label}: </span>
          {t(`today.series.${series.unit}`, { count: series.current })}
        </span>
        {series.shields > 0 && (
          <span
            className={`inline-flex items-center rounded-full bg-accent-soft font-bold text-accent ${pill}`}
            title={t(series.unit === 'days' ? 'today.series.shieldDays' : 'today.series.shieldWeeks')}
            data-testid="shields"
          >
            <Shield size={size} aria-hidden /> <span className="sr-only">{t('today.series.shields', { count: series.shields })}: </span>
            {series.shields}
          </span>
        )}
      </span>
      {standing && <span className={`text-muted ${compact ? 'text-[11px]' : 'text-sm'}`} data-testid="week-standing">{standing}</span>}
    </span>
  )
}
