/**
 * Reading a PDF with pdf.js, only ever drawn onto a canvas: no text layer, no annotation layer, so no links to click,
 * no forms, no scripts, and never the browser's own viewer. The worker is a file of its own in the bundle (`'self'`
 * in the CSP). Loaded only when a PDF shows: this module and pdf.js are a chunk of their own.
 *
 * The file comes by address, in parts (Range): the first page of a large PDF needs only a little of it.
 */
import { AnnotationMode, getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

export type PdfDocument = PDFDocumentProxy

export type Opened = { doc: Promise<PDFDocumentProxy>; close: () => void }

export function openPdf(url: string): Opened {
  const task = getDocument({
    url,
    // pdf.js 6 has no eval left and dropped this option; said anyway, in case an older build is ever bundled.
    ...({ isEvalSupported: false } as object),
    enableXfa: false,
    // No WebAssembly (the CSP allows none) and no fonts fetched from elsewhere.
    useWasm: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
  })
  return { doc: task.promise, close: () => void task.destroy() }
}

/** Draws page `number` (from 1) into the canvas, `width` CSS pixels wide, sharp on screens with dense pixels. */
export async function drawPage(doc: PDFDocumentProxy, number: number, canvas: HTMLCanvasElement, width: number): Promise<void> {
  const page = await doc.getPage(number)
  const plain = page.getViewport({ scale: 1 })
  const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
  const scale = width / plain.width
  const viewport = page.getViewport({ scale: scale * ratio })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${Math.floor(viewport.width / ratio)}px`
  canvas.style.height = `${Math.floor(viewport.height / ratio)}px`
  await page.render({ canvas, viewport, annotationMode: AnnotationMode.DISABLE }).promise
  page.cleanup()
}
