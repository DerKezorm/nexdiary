/**
 * pdf.js as nexdiary uses it: the worker from a file of the bundle, a document opened by address without XFA and without
 * WebAssembly, and pages drawn without their annotations (no links, no form fields on the picture).
 */
const { render, getDocument, options } = vi.hoisted(() => ({
  render: vi.fn(() => ({ promise: Promise.resolve() })),
  getDocument: vi.fn(() => ({ promise: Promise.resolve({ numPages: 2 }), destroy: vi.fn() })),
  options: {} as { workerSrc?: string },
}))

vi.mock('pdfjs-dist', () => ({
  AnnotationMode: { DISABLE: 0, ENABLE: 1, ENABLE_FORMS: 2, ENABLE_STORAGE: 3 },
  GlobalWorkerOptions: options,
  getDocument,
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/assets/pdf.worker.min-test.js' }))

import { drawPage, openPdf, type PdfDocument } from './pdf'

it('takes its worker from a file of the bundle', () => {
  expect(options.workerSrc).toBe('/assets/pdf.worker.min-test.js')
})

it('opens by address, in parts, without XFA forms and without WebAssembly', async () => {
  const opened = openPdf('/api/attachments/x')
  expect(await opened.doc).toEqual({ numPages: 2 })
  expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/attachments/x', enableXfa: false, useWasm: false, disableAutoFetch: true, isEvalSupported: false }))
})

it('draws a page without its annotations, at the width asked', async () => {
  const cleanup = vi.fn()
  const page = { getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render, cleanup }
  const doc = { getPage: vi.fn(async () => page) } as unknown as PdfDocument
  const canvas = document.createElement('canvas')
  await drawPage(doc, 1, canvas, 300)
  expect(render).toHaveBeenCalledTimes(1)
  const [asked] = render.mock.calls[0] as unknown as [{ canvas: HTMLCanvasElement; annotationMode: number; viewport: { width: number } }]
  expect(asked.annotationMode).toBe(0)
  expect(asked.canvas).toBe(canvas)
  expect(canvas.style.width).toBe('300px')
  expect(cleanup).toHaveBeenCalled()
})
