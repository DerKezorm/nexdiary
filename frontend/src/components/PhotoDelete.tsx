/**
 * Deleting photos, with the question first: where a photo is still used (the cover of a day, a picture in a text, a
 * note) is told, and the photo then goes everywhere at once (the server does that in one step, with both files). A
 * photo of a locked day stays, and the dialog says so. The question stands above the big view of a photo.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, photosApi, type PhotoDeletion, type PhotoUses } from '../api/client'
import { longDate } from '../lib/dates'
import { Button, Feedback } from '../pages/settings/ui'
import { Dialog } from './Dialog'

type Asked = { ids: string[]; known?: Record<string, Pick<PhotoUses, 'cover' | 'text' | 'notes'> & Partial<Pick<PhotoUses, 'date' | 'locked'>>>; resolve: (result: PhotoDeletion | null) => void }

type Api = {
  /** Asks, deletes, and gives what happened (null: the person said no). `known` spares asking the server again where
   * photos are used, when a list has that already. */
  confirmDelete: (ids: string[], known?: Asked['known']) => Promise<PhotoDeletion | null>
  /** While the question is on screen. */
  active: boolean
}

const NONE: Api = { confirmDelete: async () => null, active: false }
const Context = createContext<Api>(NONE)

// eslint-disable-next-line react-refresh/only-export-components
export function useDeletePhotos(): Api {
  return useContext(Context)
}

export function PhotoDeleteProvider({ children }: { children: ReactNode }) {
  const [asked, setAsked] = useState<Asked | null>(null)
  const current = useRef<Asked | null>(null)
  const confirmDelete = useCallback<Api['confirmDelete']>(
    (ids, known) =>
      new Promise((resolve) => {
        // A second question while one is open: the first is answered with "no".
        current.current?.resolve(null)
        const next = { ids, known, resolve }
        current.current = next
        setAsked(next)
      }),
    [],
  )
  const finish = useCallback((result: PhotoDeletion | null) => {
    const question = current.current
    current.current = null
    setAsked(null)
    question?.resolve(result)
  }, [])
  const value = useMemo(() => ({ confirmDelete, active: asked !== null }), [confirmDelete, asked])
  return (
    <Context.Provider value={value}>
      {children}
      {asked && <DeleteDialog asked={asked} onFinish={finish} />}
    </Context.Provider>
  )
}

type Known = { cover: boolean; text: boolean; notes: { id: string; date: string }[]; date?: string; locked?: boolean }

function DeleteDialog({ asked, onFinish }: { asked: Asked; onFinish: (result: PhotoDeletion | null) => void }) {
  const { t, i18n } = useTranslation()
  const [uses, setUses] = useState<Known[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<PhotoDeletion | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const found = await Promise.all(asked.ids.map(async (id): Promise<Known> => asked.known?.[id] ?? (await photosApi.uses(id))))
        if (alive) setUses(found)
      } catch (error) {
        if (alive) setProblem(error instanceof ApiError ? error.code : 'internal_error')
      }
    })()
    return () => {
      alive = false
    }
  }, [asked])

  const day = (date: string) => longDate(date, i18n.language, true)
  const many = asked.ids.length > 1
  const locked = uses?.filter((use) => use.locked).length ?? 0
  const usedList = (uses ?? []).filter((use) => use.cover || use.text || use.notes.length > 0)
  const canDelete = uses !== null && locked < asked.ids.length

  const run = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const result = await photosApi.removeMany(asked.ids)
      if (result.locked.length > 0) setOutcome(result)
      else onFinish(result)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setBusy(false)
    }
  }

  if (outcome) {
    return (
      <Dialog title={t('photoDelete.title', { count: asked.ids.length })} onClose={() => onFinish(outcome)} above>
        <p className="text-sm text-ink-2" role="status">
          {t('photoDelete.someStayed', { count: outcome.locked.length })}
        </p>
        <div className="mt-4 flex justify-end">
          <Button primary onClick={() => onFinish(outcome)}>
            {t('common.done')}
          </Button>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog title={t('photoDelete.title', { count: asked.ids.length })} onClose={() => onFinish(null)} above>
      <div className="space-y-3 text-sm text-ink-2">
        {uses === null && !problem && <p>{t('photoDelete.checking')}</p>}
        {uses !== null && !many && uses[0] && (
          <>
            {uses[0].locked ? (
              <p>{t('photoDelete.locked')}</p>
            ) : usedList.length === 0 ? (
              <p>{t('photoDelete.unused')}</p>
            ) : (
              <>
                <p>{t('photoDelete.stillUsed')}</p>
                <ul className="list-disc space-y-1 pl-5" data-testid="photo-uses">
                  {uses[0].cover && <li>{t('photoDelete.useCover', { day: day(uses[0].date ?? '') })}</li>}
                  {uses[0].text && <li>{t('photoDelete.useText', { day: day(uses[0].date ?? '') })}</li>}
                  {uses[0].notes.map((note) => (
                    <li key={note.id}>{t('photoDelete.useNote', { day: day(note.date) })}</li>
                  ))}
                </ul>
                <p>{t('photoDelete.everywhere')}</p>
              </>
            )}
          </>
        )}
        {uses !== null && many && (
          <>
            <p>{t('photoDelete.many', { count: asked.ids.length })}</p>
            {usedList.length > 0 && <p>{t('photoDelete.manyUsed', { count: usedList.length })}</p>}
            {locked > 0 && <p>{t('photoDelete.manyLocked', { count: locked })}</p>}
          </>
        )}
        <Feedback problem={problem} values={{}} />
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={() => onFinish(null)}>{t('common.cancel')}</Button>
        <Button danger busy={busy} disabled={!canDelete || busy} onClick={() => void run()}>
          {t('photoDelete.confirm', { count: asked.ids.length })}
        </Button>
      </div>
    </Dialog>
  )
}
