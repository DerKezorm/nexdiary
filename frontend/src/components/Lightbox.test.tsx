/**
 * The big view of a photo: a modal dialog over the dark page, the whole original, closed by Escape, the cross or a tap
 * beside the picture, arrows and swipes between the photos of one list, the caption, the focus kept inside and given
 * back, the page behind out of reach, and a photo that can be deleted from it (after the question).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../i18n'
import { changeLanguage } from '../i18n'
import { eventually, flush, idle, until } from '../test/wait'
import { LightboxProvider, useLightbox, type ViewerPhoto } from './Lightbox'
import { PhotoDeleteProvider, useDeletePhotos } from './PhotoDelete'

type Call = { method: string; url: string; body: unknown }
let calls: Call[] = []
let root: Root
let page: HTMLDivElement
let list: ViewerPhoto[]

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const C = 'c'.repeat(32)

function Harness() {
  const { open } = useLightbox()
  const { confirmDelete } = useDeletePhotos()
  // What a page does for a photo of its list: ask through the shared question, and say whether it went.
  const withDelete = list.map((photo) =>
    photo.id === B ? { ...photo, onDelete: async () => Boolean((await confirmDelete([B]))?.deleted.includes(B)) } : photo,
  )
  return (
    <div>
      <button type="button" data-opener="1" onClick={(event) => open(withDelete, 1, event.currentTarget)}>
        Foto öffnen
      </button>
      <button type="button" data-other="1">
        Danach
      </button>
    </div>
  )
}

async function show(): Promise<void> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  page = document.createElement('div')
  page.id = 'root'
  document.body.appendChild(page)
  root = createRoot(page)
  await act(async () =>
    root.render(
      <PhotoDeleteProvider>
        <LightboxProvider>
          <Harness />
        </LightboxProvider>
      </PhotoDeleteProvider>,
    ),
  )
}

const dialog = () => document.querySelector<HTMLElement>('[data-lightbox]')
const shown = () => dialog()?.querySelector('img')?.getAttribute('data-photo-view')
const opener = () => page.querySelector<HTMLButtonElement>('[data-opener]')!
const press = (key: string, init: KeyboardEventInit = {}) => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init })))

async function open(): Promise<void> {
  opener().focus()
  await act(async () => opener().click())
  await until(dialog, 'the big view')
}

beforeEach(async () => {
  await changeLanguage('de', false)
  calls = []
  list = [
    { id: A, src: `/api/photos/${A}` },
    { id: B, src: `/api/photos/${B}`, caption: 'Der See im Abendlicht' },
    { id: C, src: `/api/photos/${C}` },
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url.endsWith('/uses')) return json({ cover: false, text: false, notes: [], date: '2026-10-04', locked: false })
      if (url === '/api/photos/delete') return json({ deleted: (JSON.parse(String(init?.body)) as { ids: string[] }).ids, locked: [], missing: [] })
      return json({})
    }),
  )
  await show()
})

afterEach(async () => {
  await act(async () => root.unmount())
  page.remove()
  vi.unstubAllGlobals()
})

describe('the big view', () => {
  it('is a modal dialog with the picture whole and the caption', async () => {
    await open()
    const box = dialog()!
    expect(box.getAttribute('role')).toBe('dialog')
    expect(box.getAttribute('aria-modal')).toBe('true')
    expect(box.getAttribute('aria-label')).toBe('Foto in Großansicht')
    expect(shown()).toBe(B)
    const image = box.querySelector('img')!
    expect(image.getAttribute('src')).toBe(`/api/photos/${B}`)
    // The whole picture inside the space, never cut.
    expect(image.className).toContain('object-contain')
    expect(box.textContent).toContain('Der See im Abendlicht')
    expect(box.textContent).toContain('2 von 3')
    // It hangs on the body, outside the page behind, and the page stands still and out of reach.
    expect(box.parentElement).toBe(document.body)
    expect(page.hasAttribute('inert')).toBe(true)
  })

  it('closes with Escape and gives the page and the focus back', async () => {
    await open()
    await press('Escape')
    await eventually(() => expect(dialog()).toBeNull(), 'the view closing')
    expect(page.hasAttribute('inert')).toBe(false)
    await eventually(() => expect(document.activeElement).toBe(opener()), 'the focus coming back')
  })

  it('closes with the cross and with a tap beside the picture, not with a tap on the picture', async () => {
    await open()
    await act(async () => dialog()!.querySelector('img')!.click())
    expect(dialog()).not.toBeNull()
    await act(async () => dialog()!.querySelector<HTMLElement>('[data-close]')!.click())
    await until(() => dialog() === null, 'the cross closing')
    await open()
    const stage = dialog()!.querySelector<HTMLElement>('img')!.parentElement!
    await act(async () => stage.click())
    await until(() => dialog() === null, 'the dark closing')
  })

  it('moves between the photos with the arrow keys and the buttons, and stops at the ends', async () => {
    await open()
    await press('ArrowRight')
    expect(shown()).toBe(C)
    expect(dialog()!.textContent).toContain('3 von 3')
    await press('ArrowRight')
    expect(shown()).toBe(C)
    expect(dialog()!.querySelector('[aria-label="Nächstes Foto"]')).toBeNull()
    await press('ArrowLeft')
    await press('ArrowLeft')
    expect(shown()).toBe(A)
    expect(dialog()!.querySelector('[aria-label="Vorheriges Foto"]')).toBeNull()
    await act(async () => dialog()!.querySelector<HTMLElement>('[aria-label="Nächstes Foto"]')!.click())
    expect(shown()).toBe(B)
  })

  it('moves with a swipe, not with a short drag or a vertical one', async () => {
    await open()
    const stage = dialog()!.querySelector<HTMLElement>('img')!.parentElement!
    const drag = async (from: [number, number], to: [number, number]) => {
      await act(async () => {
        stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: from[0], clientY: from[1], pointerId: 1 }))
        stage.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: to[0], clientY: to[1], pointerId: 1 }))
      })
    }
    await drag([100, 100], [90, 100])
    expect(shown()).toBe(B)
    await drag([100, 100], [100, 300])
    expect(shown()).toBe(B)
    await drag([300, 100], [100, 110])
    expect(shown()).toBe(C)
    await drag([100, 100], [300, 110])
    expect(shown()).toBe(B)
  })

  it('keeps the focus inside while it is open: Tab goes round, and the cross has it first', async () => {
    await open()
    const box = dialog()!
    const close = box.querySelector<HTMLElement>('[data-close]')!
    expect(document.activeElement).toBe(close)
    const buttons = [...box.querySelectorAll<HTMLElement>('button')]
    const last = buttons[buttons.length - 1]
    last.focus()
    await press('Tab')
    expect(document.activeElement).toBe(buttons[0])
    buttons[0].focus()
    await press('Tab', { shiftKey: true })
    expect(document.activeElement).toBe(last)
    // The keyboard of the page behind does not reach it: it is inert, a button there cannot take the focus.
    expect(page.hasAttribute('inert')).toBe(true)
  })

  it('shows no delete button for a photo that cannot be deleted, no arrows for a single one', async () => {
    list = [{ id: A, src: `/api/photos/${A}` }]
    await act(async () => root.unmount())
    page.remove()
    await show()
    await act(async () => page.querySelector<HTMLButtonElement>('[data-opener]')!.click())
    await until(dialog, 'the big view')
    expect(dialog()!.querySelector('[aria-label="Foto löschen"]')).toBeNull()
    expect(dialog()!.querySelector('[aria-label="Nächstes Foto"]')).toBeNull()
    expect(dialog()!.textContent).not.toContain(' von ')
  })
})

describe('deleting from the big view', () => {
  it('asks first, deletes on the answer, and shows the next photo', async () => {
    await open()
    await act(async () => dialog()!.querySelector<HTMLElement>('[aria-label="Foto löschen"]')!.click())
    const question = await until(() => [...document.querySelectorAll<HTMLElement>('[role=dialog]')].find((element) => element.getAttribute('aria-label') === 'Foto löschen?'), 'the question')
    // Above the big view, and nothing is deleted before the answer.
    expect(calls.some((call) => call.url === '/api/photos/delete')).toBe(false)
    await act(async () => question.querySelector<HTMLElement>('[data-close]')!.click())
    await until(() => ![...document.querySelectorAll('[role=dialog]')].some((element) => element.getAttribute('aria-label') === 'Foto löschen?'), 'the question going away')
    expect(shown()).toBe(B)
    await act(async () => dialog()!.querySelector<HTMLElement>('[aria-label="Foto löschen"]')!.click())
    const again = await until(() => [...document.querySelectorAll<HTMLElement>('[role=dialog]')].find((element) => element.getAttribute('aria-label') === 'Foto löschen?'), 'the question')
    const confirm = await until(() => [...again.querySelectorAll('button')].find((button) => button.textContent === 'Foto löschen' && !button.disabled), 'the question ready')
    await act(async () => confirm.click())
    await until(() => shown() === C, 'the next photo')
    expect(calls.find((call) => call.url === '/api/photos/delete')!.body).toEqual({ ids: [B] })
    await idle()
    expect(dialog()!.textContent).toContain('2 von 2')
  })

  it('keeps the photo in the view when the question is answered with no', async () => {
    await open()
    await act(async () => dialog()!.querySelector<HTMLElement>('[aria-label="Foto löschen"]')!.click())
    const question = await until(() => [...document.querySelectorAll<HTMLElement>('[role=dialog]')].find((element) => element.getAttribute('aria-label') === 'Foto löschen?'), 'the question')
    await act(async () => [...question.querySelectorAll('button')].find((button) => button.textContent === 'Abbrechen')!.click())
    await flush()
    await flush()
    expect(calls.some((call) => call.url === '/api/photos/delete')).toBe(false)
    expect(shown()).toBe(B)
  })
})
