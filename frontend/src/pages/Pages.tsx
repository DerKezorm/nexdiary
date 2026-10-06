/**
 * Three pages of the main menu. What they show comes with the blocks that build it (the journal, the statistics,
 * shared days); until then each one stands with its head only, in the width every page has. "Today" is
 * `TodayPage.tsx`.
 */
import { useTranslation } from 'react-i18next'

const TITLE = 'font-display text-3xl font-semibold tracking-tight sm:text-4xl'

export function JournalPage() {
  const { t } = useTranslation()
  return (
    <div className="page pb-28 lg:pb-12">
      <header className="pt-8 pb-5">
        <h1 className={TITLE}>{t('journal.title')}</h1>
      </header>
    </div>
  )
}

export function StatsPage() {
  const { t } = useTranslation()
  return (
    <div className="page space-y-6 pt-8 pb-28 lg:pb-12">
      <h1 className={TITLE}>{t('stats.title')}</h1>
    </div>
  )
}

export function SharedPage() {
  const { t } = useTranslation()
  return (
    <div className="page space-y-5 pt-8 pb-28 lg:pb-12">
      <h1 className={TITLE}>{t('shared.title')}</h1>
    </div>
  )
}
