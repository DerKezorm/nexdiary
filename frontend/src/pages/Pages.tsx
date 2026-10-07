/**
 * The statistics: what it shows comes with the block that builds it (B8); until then the page stands with its head
 * only, in the width every page has. "Today" is `TodayPage.tsx`, the journal `JournalPage.tsx`, shared days
 * `SharedPage.tsx`.
 */
import { useTranslation } from 'react-i18next'

const TITLE = 'font-display text-3xl font-semibold tracking-tight sm:text-4xl'

export function StatsPage() {
  const { t } = useTranslation()
  return (
    <div className="page space-y-6 pt-8 pb-28 lg:pb-12">
      <h1 className={TITLE}>{t('stats.title')}</h1>
    </div>
  )
}
