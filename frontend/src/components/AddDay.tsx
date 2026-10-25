/**
 * "Tag nachtragen": a day before today written up afterwards, also one without a single note (those already stand under
 * "Ohne Seite"). A small dialog with a date, yesterday preselected, nothing after today; a day that has a page opens
 * to be read, any other in the writing view.
 */
import { CalendarPlus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { ApiError, diaryApi } from '../api/client'
import { addDays, todayIn } from '../lib/dates'
import { errorText } from '../lib/errors'
import { Button } from '../pages/settings/ui'
import { useAuth } from '../state/auth'
import { Dialog } from './Dialog'

/** The server takes no day before this one. */
const FIRST_DAY = '1900-01-01'

export function AddDayButton() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('addDay.button')}
        title={t('addDay.button')}
        className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full border border-line bg-sheet px-3 text-sm font-semibold text-ink-2 transition hover:text-ink sm:px-4"
        data-add-day
      >
        <CalendarPlus size={17} aria-hidden /> <span className="hidden sm:inline">{t('addDay.button')}</span>
      </button>
      {open && <AddDayDialog onClose={() => setOpen(false)} />}
    </>
  )
}

function AddDayDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const navigate = useNavigate()
  const [today] = useState(() => todayIn(me?.profile?.timezone))
  const [date, setDate] = useState(() => addDays(today, -1))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const fits = /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= FIRST_DAY && date <= today

  const go = async (event: FormEvent) => {
    event.preventDefault()
    if (!fits || busy) return
    setBusy(true)
    setProblem(null)
    try {
      await diaryApi.day(date)
      navigate(`/tag/${date}`)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'not_found') navigate(`/tag/${date}/schreiben`)
      else {
        setProblem(error instanceof ApiError ? error.code : 'internal_error')
        setBusy(false)
      }
    }
  }

  return (
    <Dialog title={t('addDay.title')} onClose={onClose}>
      <form className="space-y-4" onSubmit={(event) => void go(event)}>
        <p className="text-sm text-ink-2">{t('addDay.text')}</p>
        <label className="block">
          <span className="mb-1.5 block text-sm font-semibold">{t('addDay.date')}</span>
          <input
            type="date"
            value={date}
            min={FIRST_DAY}
            max={today}
            required
            onChange={(event) => setDate(event.target.value)}
            className="w-full rounded-xl border border-line bg-sheet px-3.5 py-2.5 text-ink focus:border-accent focus:outline-none"
          />
        </label>
        {problem && <p className="text-sm text-bad">{errorText(problem)}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" primary busy={busy} disabled={!fits}>
            {t('addDay.go')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
