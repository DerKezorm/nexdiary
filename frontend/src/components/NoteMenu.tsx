/**
 * The menu of a note: move it to the day before or the day after (a note written after midnight may belong to the other
 * day). Not offered into the future or out of a locked day; the server refuses those in any case.
 */
import { MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { Note } from '../api/client'
import type { TodayState } from '../state/today'

export function NoteMenu({ note, today, className = '' }: { note: Note; today: TodayState; className?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  const data = today.data
  if (!data || data.day?.locked) return null
  // The last day a note may go to: today, which after midnight is the later of the two days of the night.
  const last = data.night?.active ? data.night.today : data.date
  const entries = [
    { direction: 'previous' as const, label: t('today.moveBack'), shown: true },
    { direction: 'next' as const, label: t('today.moveForward'), shown: note.date < last },
  ].filter((entry) => entry.shown)
  return (
    <span ref={box} className={`relative self-start ${className}`}>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={t('today.moreNote')}
        onClick={() => setOpen(!open)}
        className="rounded-full p-1.5 text-muted opacity-0 group-hover:opacity-100 hover:text-ink focus:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <span role="menu" className="card rise absolute top-full right-0 z-40 mt-1 block w-60 p-1.5">
          {entries.map((entry) => (
            <button
              key={entry.direction}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                void today.moveNote(note.id, entry.direction)
              }}
              className="block w-full rounded-lg px-3 py-2 text-left text-sm font-semibold text-ink-2 hover:bg-sheet-2"
            >
              {entry.label}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}
