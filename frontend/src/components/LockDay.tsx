/**
 * Locking a day for good. A button with a lock on every written day (reading and writing), a question that says what
 * it means and asks for a typed word, and a mark where a locked day is shown. The server does the locking and refuses
 * every later change (409 `day_locked`); there is no way back, and the page says so before it asks.
 */
import { Lock } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, diaryApi, type DayPage } from '../api/client'
import { errorText } from '../lib/errors'
import { Dialog } from './Dialog'

/** The mark of a locked day. */
export function LockedMark({ className = '', label = false }: { className?: string; label?: boolean }) {
  const { t } = useTranslation()
  return (
    <span className={`inline-flex items-center gap-1 ${className}`} title={t('lock.badge')} data-locked-mark>
      <Lock size={14} aria-hidden />
      {label ? <span>{t('lock.badge')}</span> : <span className="sr-only">{t('lock.badge')}</span>}
    </span>
  )
}

/** The question before locking: what it means, and the word to type. `onLocked` gets the locked day. */
export function LockDialog({ date, onClose, onLocked }: { date: string; onClose: () => void; onLocked: (day: DayPage) => void }) {
  const { t } = useTranslation()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const word = t('lock.word')
  const ready = typed.trim().toLowerCase() === word.toLowerCase()
  const go = async () => {
    if (!ready || busy) return
    setBusy(true)
    try {
      onLocked(await diaryApi.lock(date))
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title={t('lock.title')} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void go()
        }}
      >
        <p className="text-sm leading-relaxed text-ink-2">{t('lock.consequence')}</p>
        <label className="mt-4 block text-sm font-semibold">
          {t('lock.typeIt', { word })}
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="mt-1.5 block h-11 w-full rounded-xl border border-line bg-paper px-3 font-normal text-ink focus:border-accent focus:outline-none"
          />
        </label>
        {problem && (
          <p role="alert" className="mt-3 text-sm text-bad">
            {errorText(problem)}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-semibold text-ink-2 hover:bg-sheet-2">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={!ready || busy} className="inline-flex h-10 items-center gap-2 rounded-full bg-bad px-4 text-sm font-semibold text-paper transition hover:brightness-105 disabled:pointer-events-none disabled:opacity-50">
            <Lock size={15} aria-hidden /> {t('lock.confirm')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
