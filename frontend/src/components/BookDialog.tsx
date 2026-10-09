/**
 * "2026 als Buch", as the mock's dialog: three pages as a preview (the title page with six covers, a chapter, a day),
 * the format and what goes in, about how many pages, and "PDF erstellen". The server sets the book in the background
 * (`/api/book`); this dialog asks how far it is until it is done, then the browser fetches the PDF once, by itself.
 * Closing the dialog while the book is set gives it up.
 */
import { Download, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, journalApi, type JournalDay, type JournalVolume } from '../api/client'
import { bookApi, type BookFormat } from '../api/review'
import { CoverImage } from '../covers/Cover'
import { longDate, monthName } from '../lib/dates'
import { errorText } from '../lib/errors'
import { Dialog } from './Dialog'

/** How often the dialog asks whether the book is done. */
const BOOK_POLL_MS = 1000

const PAGE = 'aspect-[1/1.414] w-full overflow-hidden rounded-md border border-line bg-[#fffdf8] text-[#3b2f27] shadow-soft'

function Row({ label, on, set }: { label: string; on: boolean; set: (value: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="font-semibold">{label}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => set(!on)} className={`relative h-7 w-12 shrink-0 rounded-full transition ${on ? 'bg-accent' : 'bg-line'}`}>
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-sheet shadow transition-all ${on ? 'left-6' : 'left-1'}`} />
      </button>
    </div>
  )
}

export function BookDialog({ volume, name, onClose, onDone, pollMs = BOOK_POLL_MS }: { volume: JournalVolume; name: string; onClose: () => void; onDone: (file: string, pages: number) => void; pollMs?: number }) {
  const { t, i18n } = useTranslation()
  const [format, setFormat] = useState<BookFormat>('a5')
  const [photos, setPhotos] = useState(true)
  const [values, setValues] = useState(false)
  const [notes, setNotes] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [days, setDays] = useState<JournalDay[]>([])
  /** The job being set: given up when the dialog closes before it is done. */
  const job = useRef<string | null>(null)
  const alive = useRef(true)
  const year = volume.year

  useEffect(() => {
    alive.current = true
    journalApi.page(undefined, undefined, 60, year).then(
      (page) => alive.current && setDays(page.days),
      () => undefined,
    )
    return () => {
      alive.current = false
      if (job.current) void bookApi.discard(job.current).catch(() => undefined)
    }
  }, [year])

  const sorted = [...days].reverse()
  const sample = sorted.find((day) => day.excerpt.length > 200) ?? sorted[0]
  const sampleMonth = sample ? Number(sample.date.slice(5, 7)) : 0
  const months = volume.months.filter((count) => count > 0).length
  const pages = 2 + months + volume.pages

  const say = (code: string) => setProblem(i18n.exists(`book.errors.${code}`) ? t(`book.errors.${code}`) : errorText(code))

  const make = async () => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      const started = await bookApi.start(year, format, photos, values, notes)
      job.current = started.id
      let state = started
      while (state.state === 'working') {
        await new Promise((resolve) => window.setTimeout(resolve, pollMs))
        if (!alive.current) return
        state = await bookApi.status(started.id)
      }
      if (state.state !== 'done') {
        job.current = null
        say(state.error ?? 'book_failed')
        setBusy(false)
        return
      }
      // The browser fetches it itself, as a download: the PDF is never held by the page.
      const file = `nexdiary-${year}.pdf`
      const link = document.createElement('a')
      link.href = bookApi.pdfUrl(started.id)
      link.download = file
      document.body.appendChild(link)
      link.click()
      link.remove()
      job.current = null
      onDone(file, state.pages)
    } catch (error) {
      job.current = null
      if (!alive.current) return
      say(error instanceof ApiError ? error.code : 'internal_error')
      setBusy(false)
    }
  }

  return (
    <Dialog title={t('book.title', { year })} onClose={onClose} wide>
      <p className="-mt-2 mb-5 text-sm text-ink-2">{t('book.intro')}</p>
      <div className="mb-6 grid grid-cols-3 gap-3 sm:gap-5" aria-label={t('book.preview')} role="group">
        <div className={PAGE}>
          <div className="grid h-3/5 grid-cols-3 gap-px">
            {photos && sorted.slice(-6).map((day) => <CoverImage key={day.date} cover={day.cover} crop={day.cover_crop} className="h-full w-full" />)}
          </div>
          <div className="p-[8%] text-center">
            <p className="font-display text-[clamp(0.9rem,2.6vw,1.6rem)] font-semibold">{year}</p>
            <p className="mt-1 font-serif text-[clamp(0.5rem,1.2vw,0.75rem)] text-[#6b5a4c]">{t('book.of', { name })}</p>
          </div>
        </div>
        <div className={`${PAGE} flex flex-col items-center justify-center`}>
          <p className="font-serif text-[clamp(0.45rem,1vw,0.65rem)] tracking-[0.3em] text-[#8a7867] uppercase">{t('book.chapter')}</p>
          <p className="font-display text-[clamp(0.9rem,2.4vw,1.5rem)] font-semibold">{sample ? monthName(sample.date, i18n.language) : ''}</p>
          <p className="mt-1 font-serif text-[clamp(0.45rem,1vw,0.65rem)] text-[#8a7867]">{sample ? t('book.days', { count: volume.months[sampleMonth - 1] ?? 0 }) : ''}</p>
        </div>
        <div className={PAGE}>
          {photos && sample && <CoverImage cover={sample.cover} crop={sample.cover_crop} className="aspect-[16/9] w-full" />}
          {sample && (
            <div className="p-[7%]">
              <p className="text-[clamp(0.35rem,0.8vw,0.55rem)] font-bold tracking-wide text-[#8a7867] uppercase">{longDate(sample.date, i18n.language, true)}</p>
              <p className="font-display text-[clamp(0.55rem,1.3vw,0.9rem)] leading-tight font-semibold">{sample.title || t('journal.untitled')}</p>
              <p className="mt-1 font-serif text-[clamp(0.3rem,0.75vw,0.5rem)] leading-snug text-[#6b5a4c]">{sample.excerpt.slice(0, 260)} …</p>
              {values && sample.first_value && (
                <p className="mt-1 text-[clamp(0.3rem,0.7vw,0.45rem)] text-[#8a7867]">
                  {sample.first_value.name} {sample.first_value.value}/10
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="card divide-y divide-line">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <span className="font-semibold">{t('book.format')}</span>
          <div role="radiogroup" aria-label={t('book.format')} className="flex rounded-full bg-sheet-2 p-1 text-sm font-semibold">
            {(['a5', 'a4'] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={format === value} onClick={() => setFormat(value)} className={`rounded-full px-3 py-0.5 ${format === value ? 'bg-sheet text-ink shadow-sm' : 'text-muted'}`}>
                {t(`book.${value}`)}
              </button>
            ))}
          </div>
        </div>
        <Row label={t('book.photos')} on={photos} set={setPhotos} />
        <Row label={t('book.values')} on={values} set={setValues} />
        <Row label={t('book.notes')} on={notes} set={setNotes} />
      </div>
      {problem && (
        <p role="alert" className="mt-4 text-sm text-bad">
          {problem}
        </p>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{t('book.about', { count: pages })}</p>
        <button
          type="button"
          onClick={() => void make()}
          disabled={busy}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-accent px-5 text-[0.95rem] font-semibold text-accent-ink shadow-soft transition hover:brightness-105 disabled:pointer-events-none disabled:opacity-60"
        >
          {busy ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <Download size={18} aria-hidden />} {busy ? t('book.making') : t('book.make')}
        </button>
      </div>
    </Dialog>
  )
}
