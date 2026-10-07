/**
 * "One year ago today": the page of the same day a year back, as a card that leads to it. On the page of a day it is
 * a quiet line; on the statistics (`roomy`) it is larger and shows the start of the text.
 */
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import type { CoverCropValue } from '../api/client'
import { CoverImage } from '../covers/Cover'

export function YearAgo({ day, roomy = false }: { day: { date: string; title: string; cover: string; cover_crop?: CoverCropValue | null; excerpt?: string }; roomy?: boolean }) {
  const { t } = useTranslation()
  return (
    <Link to={`/tag/${day.date}`} className={`card flex items-center gap-4 hover:border-accent ${roomy ? 'p-5' : 'mt-6 p-4'}`}>
      <CoverImage cover={day.cover} crop={day.cover_crop} className={`h-16 shrink-0 ${roomy ? 'w-24 rounded-xl' : 'w-20 rounded-lg'}`} />
      <div className="min-w-0">
        <div className="text-xs font-bold tracking-wide text-accent uppercase">{t('entry.yearAgo')}</div>
        <div className="truncate font-display text-lg font-semibold">{day.title || t('journal.untitled')}</div>
        {roomy && day.excerpt && <div className="truncate font-serif text-sm text-ink-2">{day.excerpt}</div>}
      </div>
    </Link>
  )
}
