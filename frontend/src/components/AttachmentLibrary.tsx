/**
 * The tab "Anhänge" of "Meine Fotos": every own attachment in one list, a kind at a time (chips in a row that scrolls
 * sideways on a phone), newest or largest first, a page at a time. Each row links to its day and can be deleted (asked
 * first). Largest first helps when the storage runs full.
 */
import { FileText, Film, Link2, Loader2, Mic, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { ApiError, attachmentsApi, type Attachment, type AttachmentKind } from '../api/client'
import { clock } from '../lib/attachments'
import { formatBytes } from '../lib/bytes'
import { errorText } from '../lib/errors'
import { Button, Segment } from '../pages/settings/ui'
import { Chip } from './Chip'
import { Dialog } from './Dialog'

const ICON = { video: Film, audio: Mic, pdf: FileText, link: Link2 }
const FILTERS: ('' | AttachmentKind)[] = ['', 'video', 'audio', 'pdf', 'link']
type Order = 'new' | 'size'

/** "4. Okt. 2026": a calendar day, short. */
function shortDate(day: string, language: string): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, date)))
}

export function AttachmentLibrary({ onRemoved }: { onRemoved?: () => void }) {
  const { t, i18n } = useTranslation()
  const [kind, setKind] = useState<'' | AttachmentKind>('')
  const [order, setOrder] = useState<Order>('new')
  const [items, setItems] = useState<Attachment[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Attachment | null>(null)
  /** Which request is the current one: an answer to an older one (another filter) is dropped. */
  const round = useRef(0)

  const loadPage = useCallback(async (which: '' | AttachmentKind, by: Order, after: string) => {
    const mine = round.current
    setLoading(true)
    try {
      const page = await attachmentsApi.library(which, by, after)
      if (mine !== round.current) return
      const found = Array.isArray(page?.attachments) ? page.attachments : []
      setItems((current) => {
        const known = new Set(current.map((item) => item.id))
        return [...current, ...found.filter((item) => !known.has(item.id))]
      })
      setNext(typeof page?.next === 'string' ? page.next : null)
      setProblem(null)
    } catch (error) {
      if (mine === round.current) setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      if (mine === round.current) {
        setLoading(false)
        setLoaded(true)
      }
    }
  }, [])

  useEffect(() => {
    round.current += 1
    setItems([])
    setNext(null)
    setLoaded(false)
    void loadPage(kind, order, '')
  }, [kind, order, loadPage])

  const closeRemove = useCallback(() => setRemoving(null), [])
  const remove = async () => {
    const gone = removing
    if (!gone) return
    try {
      await attachmentsApi.remove(gone.id)
      setItems((current) => current.filter((item) => item.id !== gone.id))
      setProblem(null)
      onRemoved?.()
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      setRemoving(null)
    }
  }

  const label = (value: '' | AttachmentKind) => t(`attachments.library.${value || 'all'}`)
  return (
    <div className="space-y-5" data-attachment-library>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="scroll-x -mx-1 flex max-w-full gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label={t('attachments.library.filter')} data-kind-filter>
          {FILTERS.map((value) => (
            <span key={value || 'all'} className="shrink-0">
              <Chip active={kind === value} pressed={kind === value} onClick={() => setKind(value)}>
                {label(value)}
              </Chip>
            </span>
          ))}
        </div>
        <Segment
          value={order}
          onChange={setOrder}
          label={t('attachments.library.order')}
          options={[
            { value: 'new', label: t('attachments.library.newest') },
            { value: 'size', label: t('attachments.library.largest') },
          ]}
        />
      </div>
      {problem && (
        <p role="alert" className="text-sm text-bad">
          {errorText(problem)}
        </p>
      )}
      {!loaded && !problem && <p className="text-sm text-muted">{t('attachments.library.loading')}</p>}
      {loaded && items.length === 0 && !problem ? (
        <p className="card p-6 text-center text-muted" data-library-empty>
          {t('attachments.library.none')}
        </p>
      ) : (
        items.length > 0 && (
          <ul className="card divide-y divide-line">
            {items.map((item) => {
              const Icon = ICON[item.kind]
              return (
                <li key={item.id} className="flex items-center gap-3 px-4 py-3" data-attachment={item.id}>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <Icon size={18} aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{item.name}</div>
                    <div className="truncate text-xs text-muted">
                      {t(`attachments.kind.${item.kind}`)}
                      {item.seconds ? ` · ${clock(item.seconds)}` : ''}
                      {item.codec === 'hevc' ? ' · HEVC' : ''}
                      {' · '}
                      <Link to={`/tag/${item.date}`} className="hover:text-ink hover:underline" aria-label={t('attachments.library.dayOf', { day: shortDate(item.date, i18n.language) })}>
                        {shortDate(item.date, i18n.language)}
                      </Link>
                    </div>
                  </div>
                  <span className="shrink-0 text-sm text-muted tabular-nums">{item.kind === 'link' ? '' : formatBytes(item.size, i18n.language)}</span>
                  <button type="button" onClick={() => setRemoving(item)} className="rounded-full p-2 text-muted hover:bg-sheet-2 hover:text-ink" aria-label={`${t('attachments.remove')}: ${item.name}`}>
                    <Trash2 size={15} aria-hidden />
                  </button>
                </li>
              )
            })}
          </ul>
        )
      )}
      {next !== null && (
        <div className="flex justify-center">
          <Button busy={loading} disabled={loading} onClick={() => void loadPage(kind, order, next)}>
            {loading ? <Loader2 size={15} className="animate-spin" aria-hidden /> : null} {t('attachments.library.more')}
          </Button>
        </div>
      )}
      {removing && (
        <Dialog title={t('attachments.removeTitle')} onClose={closeRemove}>
          <p className="text-sm text-ink-2">{t('attachments.removeText', { name: removing.name })}</p>
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" onClick={closeRemove} className="inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-semibold text-ink-2 hover:bg-sheet-2">
              {t('attachments.keep')}
            </button>
            <button type="button" onClick={() => void remove()} className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink hover:brightness-105" data-remove-confirm>
              <Trash2 size={16} aria-hidden /> {t('attachments.removeConfirm')}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  )
}
