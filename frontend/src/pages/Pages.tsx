/**
 * The four pages of the main menu. What they show comes with the blocks that build it (notes, the journal, the
 * statistics, shared days); until then each one stands with its head only, in the width every page has.
 */
import { useTranslation } from 'react-i18next'

import { useAuth } from '../state/auth'

const TITLE = 'font-display text-3xl font-semibold tracking-tight sm:text-4xl'

/** Morning until eleven, the day until six, then the evening: the greeting of "Today". */
// eslint-disable-next-line react-refresh/only-export-components
export function greetingOf(hour: number): 'morning' | 'day' | 'evening' {
  return hour < 11 ? 'morning' : hour < 18 ? 'day' : 'evening'
}

export function TodayPage({ now = new Date() }: { now?: Date }) {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const date = new Intl.DateTimeFormat(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' }).format(now)
  return (
    <div className="page pb-28 lg:pb-12">
      <header className="pt-8 pb-6">
        <p className="text-sm font-semibold tracking-wide text-muted uppercase">{date}</p>
        <h1 className={TITLE}>{t(`today.greeting.${greetingOf(now.getHours())}`, { name: me?.display_name || me?.name || '' })}</h1>
      </header>
    </div>
  )
}

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
