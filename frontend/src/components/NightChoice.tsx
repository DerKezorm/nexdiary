/**
 * After midnight: which day do the notes belong to? Between 0:00 and 3:59 the first note asks ("Zu gestern (Dienstag)"
 * or "Zu heute (Mittwoch)"); the answer holds for every device until 4:00. Afterwards a small line says where the notes
 * go, with a button to switch. The server keeps the answer and works out the date itself.
 */
import { Moon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { weekdayName, weekdayOf } from '../lib/dates'
import type { TodayState } from '../state/today'
import { Dialog } from './Dialog'

function useWeekday() {
  const { i18n } = useTranslation()
  return (day: string) => weekdayName(weekdayOf(day), i18n.language)
}

/** The question, open while a note waits for the answer. */
export function NightDialog({ today }: { today: TodayState }) {
  const { t } = useTranslation()
  const weekday = useWeekday()
  const night = today.data?.night
  if (!today.asking || !night?.active) return null
  const answers = [
    { choice: 'yesterday' as const, label: t('night.toYesterday', { weekday: weekday(night.yesterday) }) },
    { choice: 'today' as const, label: t('night.toToday', { weekday: weekday(night.today) }) },
  ]
  return (
    <Dialog title={t('night.title')} onClose={() => void today.chooseNight(null)}>
      <p className="text-sm text-ink-2">{t('night.text')}</p>
      <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
        {answers.map((answer, index) => (
          <button
            key={answer.choice}
            type="button"
            onClick={() => void today.chooseNight(answer.choice)}
            className={`inline-flex h-12 items-center justify-center rounded-full px-5 text-[0.95rem] font-semibold transition hover:brightness-105 ${index === 0 ? 'bg-accent text-accent-ink shadow-soft' : 'bg-accent-soft text-accent'}`}
          >
            {answer.label}
          </button>
        ))}
      </div>
    </Dialog>
  )
}

/** Where the notes of this night go, once the person said; "Zu heute wechseln" changes it for the rest of the night. */
export function NightHint({ today, className = '' }: { today: TodayState; className?: string }) {
  const { t } = useTranslation()
  const weekday = useWeekday()
  const night = today.data?.night
  if (!night?.active || night.choice === null) return null
  const toYesterday = night.choice === 'yesterday'
  const here = toYesterday ? night.yesterday : night.today
  return (
    <p className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-accent-soft/60 px-3.5 py-2 text-sm text-ink-2 ${className}`} role="status" data-night-hint>
      <Moon size={15} className="shrink-0 text-accent" aria-hidden />
      <span className="min-w-0">{t(toYesterday ? 'night.hintYesterday' : 'night.hintToday', { weekday: weekday(here) })}</span>
      <button type="button" onClick={() => void today.chooseNight(toYesterday ? 'today' : 'yesterday')} className="font-semibold text-accent underline-offset-2 hover:underline">
        {t(toYesterday ? 'night.switchToToday' : 'night.switchToYesterday')}
      </button>
    </p>
  )
}
