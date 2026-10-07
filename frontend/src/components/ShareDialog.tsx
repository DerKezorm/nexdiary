/**
 * "Diesen Tag teilen", as the mock's: the other people on the server to choose from, and what they see. Text and
 * photos always; the values and the notes of the day only when switched on, for everybody chosen alike. Nobody chosen
 * ends sharing the day. The server decides who may be chosen and what goes out; this only asks.
 */
import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, sharingApi, type DayShares, type Person } from '../api/client'
import { errorText } from '../lib/errors'
import { nameOf } from '../lib/people'
import { Avatar } from './Avatar'
import { Dialog } from './Dialog'

function Switch({ on, onChange, label }: { on: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={`relative h-7 w-12 shrink-0 rounded-full transition ${on ? 'bg-accent' : 'bg-line'}`}>
      <span className={`absolute top-1 h-5 w-5 rounded-full bg-sheet shadow transition-all ${on ? 'left-6' : 'left-1'}`} />
    </button>
  )
}

/** From this many people on, a field to find one. */
const SEARCH_FROM = 8

export function ShareDialog({
  date,
  shares,
  coverFromNotes = false,
  onClose,
  onShared,
}: {
  date: string
  shares: DayShares
  /** The cover is a photo from the notes: it is shown with the day all the same. */
  coverFromNotes?: boolean
  onClose: () => void
  onShared: (shares: DayShares, notice: string) => void
}) {
  const { t, i18n } = useTranslation()
  const [people, setPeople] = useState<Person[] | null>(null)
  const [who, setWho] = useState<number[]>(shares.people.map((person) => person.id))
  const [values, setValues] = useState(shares.with_values)
  const [notes, setNotes] = useState(shares.with_notes)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let alive = true
    sharingApi.people().then(
      (list) => alive && setPeople(list),
      (error) => alive && setProblem(error instanceof ApiError ? error.code : 'internal_error'),
    )
    return () => {
      alive = false
    }
  }, [])

  const chosen = (people ?? []).filter((person) => who.includes(person.id))
  const needle = query.trim().toLowerCase()
  const listed = (people ?? []).filter((person) => !needle || person.name.toLowerCase().includes(needle) || person.display_name.toLowerCase().includes(needle))
  const names = new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(chosen.map(nameOf))
  const nothingToDo = who.length === 0 && shares.people.length === 0

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      const next = await sharingApi.share(date, who, values, notes)
      onShared(next, who.length ? t('share.done', { names }) : t('share.stopped'))
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
      setBusy(false)
    }
  }

  return (
    <Dialog title={t('share.title')} onClose={onClose}>
      <p className="mb-4 text-sm text-ink-2">{t('share.intro')}</p>
      {people && people.length === 0 && <p className="rounded-2xl bg-sheet-2 px-4 py-3 text-sm text-ink-2">{t('share.nobody')}</p>}
      {people && people.length >= SEARCH_FROM && (
        <label className="mb-3 flex items-center gap-2 rounded-full border border-line bg-paper px-3 py-2">
          <Search size={15} className="text-muted" aria-hidden />
          <input value={query} maxLength={80} onChange={(e) => setQuery(e.target.value)} placeholder={t('share.search')} aria-label={t('share.search')} className="min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none" />
        </label>
      )}
      <div className="space-y-2">
        {listed.map((person) => {
          const on = who.includes(person.id)
          return (
            <button
              key={person.id}
              type="button"
              aria-pressed={on}
              onClick={() => setWho(on ? who.filter((id) => id !== person.id) : [...who, person.id])}
              className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition ${on ? 'border-accent bg-accent-soft/60' : 'border-line hover:bg-sheet-2'}`}
            >
              <Avatar person={person} size={34} />
              <span className="min-w-0 flex-1 truncate font-semibold">{nameOf(person)}</span>
              <span className={`h-5 w-5 shrink-0 rounded-full border-2 ${on ? 'border-accent bg-accent' : 'border-line'}`} />
            </button>
          )
        })}
      </div>
      <div className="mt-5 space-y-3 border-t border-line pt-4">
        <p className="text-sm font-semibold">{chosen.length === 1 ? t('share.whatSees', { name: nameOf(chosen[0]) }) : t('share.whatSeesFamily')}</p>
        <div className="flex items-center justify-between text-sm">
          <span>{t('share.textPhotos')}</span>
          <span className="text-muted">{t('share.always')}</span>
        </div>
        {coverFromNotes && <p className="rounded-xl bg-sheet-2 px-3 py-2 text-xs text-ink-2">{t('share.coverFromNotes')}</p>}
        <div className="flex items-center justify-between gap-4 text-sm">
          <span>{t('share.values')}</span>
          <Switch on={values} onChange={setValues} label={t('share.valuesLabel')} />
        </div>
        <div className="flex items-center justify-between gap-4 text-sm">
          <span>{t('share.notes')}</span>
          <Switch on={notes} onChange={setNotes} label={t('share.notesLabel')} />
        </div>
      </div>
      {problem && <p className="mt-4 text-sm text-bad">{errorText(problem)}</p>}
      {/* Always in reach, however many people are listed above. */}
      <div className="sticky -bottom-6 -mx-6 -mb-6 mt-6 flex justify-end gap-2 border-t border-line bg-sheet px-6 py-4">
        <button type="button" onClick={onClose} className="inline-flex h-11 items-center justify-center rounded-full px-5 text-[0.95rem] font-semibold text-ink-2 transition hover:bg-sheet-2">
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || people === null || nothingToDo}
          className="inline-flex h-11 items-center justify-center rounded-full bg-accent px-5 text-[0.95rem] font-semibold text-accent-ink shadow-soft transition hover:brightness-105 disabled:pointer-events-none disabled:opacity-50"
        >
          {who.length ? t('share.share') : t('share.stop')}
        </button>
      </div>
    </Dialog>
  )
}
