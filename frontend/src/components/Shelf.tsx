/**
 * The bookshelf, as the mock's `Shelf.tsx`: every year with a page is a volume, as wide as it is full, in the colour
 * of the accent, the year upright on its spine; after them an empty one waits for the next year. Tapping a volume (or
 * "2026 aufschlagen") shows only that year in the journal, tapping it again shows all; "Als Buch" makes a PDF of it.
 * The numbers come from the server (`/api/journal/overview`): the first volume counts from its first page on, the days
 * left are those after today up to New Year's Eve, in the person's time zone.
 */
import { BookOpen, Download } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { JournalVolume } from '../api/client'
import { BookDialog } from './BookDialog'

/** Volumes darker the older they are: as the mock for three, the older ones go on getting darker. */
function shade(index: number, count: number): number {
  return Math.max(40, Math.min(100, 70 + (index - Math.max(0, count - 3)) * 10))
}

export function Shelf({ volumes, thisYear, daysLeft, year, onYear, name }: { volumes: JournalVolume[]; thisYear: number; daysLeft: number; year: number | null; onYear: (year: number | null) => void; name: string }) {
  const { t } = useTranslation()
  const [book, setBook] = useState<JournalVolume | null>(null)
  const [done, setDone] = useState<string | null>(null)
  if (volumes.length === 0) return null
  const current = volumes.find((volume) => volume.year === (year ?? thisYear)) ?? volumes[volumes.length - 1]
  const share = current.pages / current.days
  const waiting = volumes.some((volume) => volume.year === thisYear) ? thisYear + 1 : Math.max(thisYear, current.year + 1)

  return (
    <section className="card overflow-hidden" data-shelf>
      <div className="grid gap-6 p-5 sm:p-6 md:grid-cols-[auto_1fr] md:items-end">
        <div className="min-w-0">
          <div className="scroll-x flex items-end gap-2 overflow-x-auto px-1 pt-2" role="list" aria-label={t('shelf.label')}>
            {volumes.map((volume, index) => {
              const active = volume.year === current.year
              const width = 30 + Math.round((volume.pages / volume.days) * 46)
              return (
                <button
                  key={volume.year}
                  type="button"
                  role="listitem"
                  onClick={() => onYear(year === volume.year ? null : volume.year)}
                  aria-pressed={year === volume.year}
                  aria-label={t('shelf.volumeTitle', { year: volume.year, count: volume.pages })}
                  title={t('shelf.volumeTitle', { year: volume.year, count: volume.pages })}
                  className={`group relative flex h-44 shrink-0 flex-col items-center justify-between rounded-t-[5px] rounded-b-[3px] py-3 text-accent-ink shadow-soft transition hover:-translate-y-1 ${active ? '-translate-y-1.5' : ''}`}
                  style={{ width, background: `color-mix(in srgb, var(--accent) ${shade(index, volumes.length)}%, var(--ink))` }}
                  data-volume={volume.year}
                >
                  <span className="h-px w-3/5 bg-accent-ink/50" />
                  <span className="rotate-180 font-display text-sm font-semibold [writing-mode:vertical-rl]">{volume.year}</span>
                  <span className="h-px w-3/5 bg-accent-ink/50" />
                  {active && <span className="absolute -bottom-3 h-1.5 w-1.5 rounded-full bg-accent" />}
                </button>
              )
            })}
            <div className="flex h-44 w-10 shrink-0 items-center justify-center rounded-[4px] border-2 border-dashed border-line text-muted" title={t('shelf.waiting', { year: waiting })}>
              <span className="rotate-180 font-display text-xs [writing-mode:vertical-rl]">{waiting}</span>
            </div>
          </div>
          <div className="mt-3 h-2 rounded-full bg-line/80" aria-hidden />
        </div>

        <div className="min-w-0">
          <p className="text-xs font-bold tracking-wide text-muted uppercase">{t('shelf.volume', { year: current.year })}</p>
          <p className="mt-0.5 font-display text-2xl font-semibold tracking-tight">{t('shelf.pages', { count: current.pages, total: current.days })}</p>
          <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-sheet-2">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, share * 100)}%` }} />
          </div>
          <p className="mt-2 text-sm text-ink-2">{current.year !== thisYear ? t('shelf.closed') : daysLeft > 0 ? t('shelf.open', { count: daysLeft }) : t('shelf.lastDay')}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onYear(year === current.year ? null : current.year)}
              aria-pressed={year === current.year}
              className={`inline-flex h-8 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold transition ${year === current.year ? 'bg-accent text-accent-ink shadow-soft hover:brightness-105' : 'bg-accent-soft text-accent hover:brightness-[0.98]'}`}
            >
              <BookOpen size={15} aria-hidden /> {year === current.year ? t('shelf.only', { year: current.year }) : t('shelf.show', { year: current.year })}
            </button>
            <button type="button" onClick={() => setBook(current)} className="inline-flex h-8 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold text-ink-2 transition hover:bg-sheet-2">
              <Download size={15} aria-hidden /> {t('shelf.asBook')}
            </button>
          </div>
          {done && (
            <p role="status" className="mt-3 text-sm font-semibold text-accent">
              {done}
            </p>
          )}
        </div>
      </div>
      {book && (
        <BookDialog
          volume={book}
          name={name}
          onClose={() => setBook(null)}
          onDone={(file, pages) => {
            setBook(null)
            setDone(t('shelf.done', { name: file, count: pages }))
          }}
        />
      )}
    </section>
  )
}
