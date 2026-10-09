/**
 * Deleting the page of a day, from the reading page and from the writing page. The question says what goes (title,
 * text, tags, values, the pictures uploaded only for the text, and every share of the day, by name) and what stays (the
 * notes and the photos of the day), as the server does it (`DELETE /api/days/{date}`, which takes the day's draft along).
 * Never on a locked day: the server refuses that as well.
 */
import { Loader2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, diaryApi, sharingApi, type Recipient } from '../api/client'
import { errorText } from '../lib/errors'
import { nameOf } from '../lib/people'
import { Dialog } from './Dialog'

function namesOf(names: string[], language: string): string {
  try {
    return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}

/** The question before deleting the page of `date`. `shared`: who the day is shared with, when the caller knows it
 * already (else it is asked for here). `unsaved`: the writing page has changes that would go too. `beforeDelete` runs
 * before the request (the writing page stops its drafts there), `onFailed` when the server refused. */
export function DeletePageDialog({ date, shared, unsaved = false, beforeDelete, onFailed, onClose, onDeleted }: { date: string; shared?: Recipient[]; unsaved?: boolean; beforeDelete?: () => Promise<void>; onFailed?: () => void; onClose: () => void; onDeleted: () => void }) {
  const { t, i18n } = useTranslation()
  const [people, setPeople] = useState<Recipient[] | null>(shared ?? null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => {
    if (shared) return
    let gone = false
    sharingApi.ofDay(date).then(
      (found) => !gone && setPeople(found.people),
      // Not known: the question says nothing of shares then, and the button waits for nothing.
      () => !gone && setPeople([]),
    )
    return () => {
      gone = true
    }
  }, [date, shared])

  const go = async () => {
    if (busy || people === null) return
    setBusy(true)
    setProblem(null)
    try {
      await beforeDelete?.()
      await diaryApi.deleteDay(date)
      onDeleted()
    } catch (error) {
      onFailed?.()
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
      setBusy(false)
    }
  }

  return (
    <Dialog title={t('entry.deleteTitle')} onClose={onClose}>
      <div className="space-y-2 text-sm leading-relaxed text-ink-2" data-delete-page>
        <p>{t('entry.deleteText')}</p>
        {people && people.length > 0 && <p data-delete-shared>{t('entry.deleteShared', { names: namesOf(people.map(nameOf), i18n.language), count: people.length })}</p>}
        {unsaved && <p>{t('entry.deleteUnsaved')}</p>}
      </div>
      {problem && (
        <p role="alert" className="mt-3 text-sm text-bad">
          {errorText(problem)}
        </p>
      )}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onClose} className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-semibold text-ink-2 hover:bg-sheet-2">
          {t('common.cancel')}
        </button>
        <button type="button" onClick={() => void go()} disabled={busy || people === null} className="inline-flex h-10 items-center gap-2 rounded-full bg-bad px-4 text-sm font-semibold text-paper transition hover:brightness-105 disabled:pointer-events-none disabled:opacity-50">
          {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Trash2 size={15} aria-hidden />} {t('entry.deleteGo')}
        </button>
      </div>
    </Dialog>
  )
}
