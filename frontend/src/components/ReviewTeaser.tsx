/**
 * The strip on "Today", as the mock's `ReviewTeaser`: from Monday to Wednesday last week with its small covers, from
 * the 1st to the 3rd of a month last month instead; only when that time has a page (the server decides, in the
 * person's time zone). A small X hides it for that week or month on this device.
 */
import { ArrowRight, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { reviewApi, type ReviewTeaser as Teaser } from '../api/review'
import { CoverImage } from '../covers/Cover'
import { monthName } from '../lib/dates'

const STORAGE_KEY = 'nexdiary.review.hidden'
/** The periods remembered as hidden; older ones fall out. */
const REMEMBERED = 12

function keyOf(teaser: Teaser): string {
  return `${teaser.kind}:${teaser.start}`
}

function hidden(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function hide(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...hidden().filter((item) => item !== key), key].slice(-REMEMBERED)))
  } catch {
    // A browser that keeps nothing shows the strip again next time; nothing else depends on it.
  }
}

export function ReviewTeaser() {
  const { t, i18n } = useTranslation()
  const [teaser, setTeaser] = useState<Teaser | null>(null)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    let alive = true
    reviewApi.teaser().then(
      (found) => alive && setTeaser(found.teaser),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [])

  if (!teaser || gone || hidden().includes(keyOf(teaser))) return null
  const week = teaser.kind === 'week'
  const target = `/rueckblick/${week ? 'woche' : 'monat'}/${teaser.start}`
  return (
    <div className="card group relative flex items-center overflow-hidden" data-review-teaser>
      <Link to={target} className="flex min-w-0 flex-1 items-center gap-4 p-3 pr-2">
        <div className="flex shrink-0 gap-1" aria-hidden>
          {teaser.covers.map((cover, index) =>
            cover ? (
              <CoverImage key={cover.date} cover={cover.cover} crop={cover.cover_crop} className="h-14 w-7 rounded-md sm:w-9" />
            ) : (
              <span key={`free${index}`} className="h-14 w-7 rounded-md border border-dashed border-line sm:w-9" />
            ),
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold tracking-wide text-accent uppercase">{t('review.teaser')}</p>
          <p className="font-display text-lg leading-snug font-semibold group-hover:text-accent">
            {week ? t('review.teaserWeek', { count: teaser.written }) : t('review.teaserMonth', { month: monthName(teaser.start, i18n.language), count: teaser.written })}
          </p>
        </div>
        <ArrowRight size={18} className="shrink-0 text-muted group-hover:text-accent" aria-hidden />
      </Link>
      <button
        type="button"
        onClick={() => {
          hide(keyOf(teaser))
          setGone(true)
        }}
        className="mr-2 shrink-0 self-start rounded-full p-1.5 text-muted hover:bg-sheet-2 hover:text-ink"
        aria-label={t('review.dismiss')}
      >
        <X size={14} />
      </button>
    </div>
  )
}
