/**
 * A PDF of a day, read in the app: one page at a time drawn by pdf.js, to leaf through, and the file to save. Loaded
 * only when a PDF is opened (a chunk of its own, with pdf.js). Nothing of the PDF can act: no links, no forms, no
 * scripts; it is a picture of each page.
 */
import { ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { drawPage, openPdf, type PdfDocument } from '../lib/pdf'
import { Dialog } from './Dialog'

/** The first page of a PDF as a small picture, and how many pages it has: for the tile. */
// eslint-disable-next-line react-refresh/only-export-components
export function drawFirstPage(src: string, width: number): { done: Promise<{ picture: string; pages: number }>; close: () => void } {
  const opened = openPdf(src)
  const done = (async () => {
    try {
      const doc = await opened.doc
      const canvas = document.createElement('canvas')
      await drawPage(doc, 1, canvas, width)
      return { picture: canvas.toDataURL('image/png'), pages: doc.numPages }
    } finally {
      opened.close()
    }
  })()
  return { done, close: opened.close }
}

export default function PdfViewer({ title, src, download, onClose }: { title: string; src: string; download: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [doc, setDoc] = useState<PdfDocument | null>(null)
  const [failed, setFailed] = useState(false)
  const [page, setPage] = useState(1)
  const [drawing, setDrawing] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const frame = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const opened = openPdf(src)
    let alive = true
    opened.doc.then(
      (found) => alive && setDoc(found),
      () => alive && setFailed(true),
    )
    return () => {
      alive = false
      opened.close()
    }
  }, [src])

  useEffect(() => {
    if (!doc || !canvas.current) return
    let alive = true
    setDrawing(true)
    const width = Math.max(240, Math.min(820, (frame.current?.clientWidth ?? 640) - 32))
    drawPage(doc, page, canvas.current, width).then(
      () => alive && setDrawing(false),
      () => alive && (setFailed(true), setDrawing(false)),
    )
    return () => {
      alive = false
    }
  }, [doc, page])

  const pages = doc?.numPages ?? 1
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') setPage((value) => Math.max(1, value - 1))
      else if (event.key === 'ArrowRight') setPage((value) => Math.min(pages, value + 1))
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [pages])

  return (
    <Dialog title={title} onClose={onClose} above wide>
      <div ref={frame} className="flex min-h-[12rem] justify-center overflow-auto rounded-xl bg-sheet-2 p-4 sm:p-6" data-pdf-view>
        {failed ? (
          <p className="self-center text-center text-sm text-muted">{t('attachments.pdfFailed')}</p>
        ) : (
          <>
            {!doc && <p className="self-center text-sm text-muted">{t('attachments.pdfLoading')}</p>}
            <canvas ref={canvas} className={`max-w-full rounded-sm bg-white shadow-soft ${doc ? '' : 'hidden'} ${drawing ? 'opacity-70' : ''}`} aria-label={t('attachments.pageOf', { n: page, total: pages })} role="img" />
          </>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1 || !doc} className="rounded-full p-2 text-ink-2 hover:bg-sheet-2 disabled:opacity-30" aria-label={t('attachments.previousPage')}>
            <ChevronLeft size={18} aria-hidden />
          </button>
          <span className="text-sm font-semibold tabular-nums" aria-live="polite">
            {t('attachments.pageOf', { n: page, total: pages })}
          </span>
          <button type="button" onClick={() => setPage(Math.min(pages, page + 1))} disabled={page >= pages || !doc} className="rounded-full p-2 text-ink-2 hover:bg-sheet-2 disabled:opacity-30" aria-label={t('attachments.nextPage')}>
            <ChevronRight size={18} aria-hidden />
          </button>
        </div>
        <a href={download} download className="inline-flex h-8 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold text-ink-2 transition hover:bg-sheet-2">
          <Download size={15} aria-hidden /> {t('attachments.download')}
        </a>
      </div>
    </Dialog>
  )
}
