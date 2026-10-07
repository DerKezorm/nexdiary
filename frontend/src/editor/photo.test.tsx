/**
 * A picture in the text, in the editor: the person's own photo as a block with a caption, put in with the button
 * "Image" (or a tap on a photo of a note), moved with two arrows, taken out with a third; nothing else makes one (no
 * paste, no drop, no foreign address), and the Markdown that comes out is exactly the line the server keeps.
 */
import { createRef } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../i18n'
import { changeLanguage } from '../i18n'
import { flush, until } from '../test/wait'
import { DiaryEditor, type DiaryEditorHandle, type ImageWays } from './DiaryEditor'

const ID = 'a1'.repeat(16)
const OTHER = '0f'.repeat(16)

let root: Root
let box: HTMLDivElement

async function show(value: string, handle = createRef<DiaryEditorHandle>(), images?: ImageWays, onChange: (markdown: string) => void = () => undefined): Promise<HTMLElement> {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  box = document.createElement('div')
  document.body.appendChild(box)
  root = createRoot(box)
  await act(async () => {
    root.render(<DiaryEditor ref={handle} value={value} onChange={onChange} placeholder="Schreib einfach los …" label="Text des Tages" images={images} />)
  })
  return await until(() => box.querySelector<HTMLElement>('[contenteditable=true]'), 'the editor starting')
}

beforeAll(async () => {
  await changeLanguage('de', false)
  const empty = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect
  Range.prototype.getClientRects ??= (() => []) as unknown as Range['getClientRects']
  Range.prototype.getBoundingClientRect ??= empty
})

afterEach(() => {
  act(() => root.unmount())
  box.remove()
})

const markdown = (handle: { current: DiaryEditorHandle | null }) => handle.current!.getMarkdown()!

describe('a photo in the text of the editor', () => {
  it('shows the photo as a block with its caption and writes the same line back', async () => {
    const handle = createRef<DiaryEditorHandle>()
    const editable = await show(`Vorher.\n\n![Mia am Baum](photo:${ID})\n\nNachher.`, handle)
    const figure = editable.querySelector('figure.diary-photo-edit')!
    expect(figure.querySelector('img')?.getAttribute('src')).toBe(`/api/photos/${ID}`)
    expect(figure.querySelector<HTMLInputElement>('input')?.value).toBe('Mia am Baum')
    expect(editable.querySelectorAll('img')).toHaveLength(1)
    expect(markdown(handle)).toBe(`Vorher.\n\n![Mia am Baum](photo:${ID})\n\nNachher.`)
  })

  it.each([
    ['another address', '![x](https://example.com/a.png)'],
    ['data', '![x](data:image/png;base64,AAAA)'],
    ['a capital id', `![x](photo:${ID.toUpperCase()})`],
    ['words around it', `Vorher ![x](photo:${ID}) nachher`],
    ['a quote', `> ![x](photo:${ID})`],
    ['a list', `- ![x](photo:${ID})`],
  ])('shows %s as words, never as a picture', async (_name, text) => {
    const editable = await show(text)
    expect(editable.querySelectorAll('figure, img')).toHaveLength(0)
    expect(editable.querySelectorAll('[src]')).toHaveLength(0)
  })

  it('puts a photo in after the block the caret is in, and the caret goes on below it', async () => {
    const handle = createRef<DiaryEditorHandle>()
    const editable = await show('Erster Absatz.\n\nZweiter Absatz.', handle)
    act(() => handle.current!.withView((view) => {
      // The caret in the first paragraph.
      view.dispatch(view.state.tr.setSelection((view.state.selection.constructor as unknown as { near: (pos: unknown) => never }).near(view.state.doc.resolve(3))))
    }))
    act(() => handle.current!.insertPhoto(ID))
    expect(markdown(handle)).toBe(`Erster Absatz.\n\n![](photo:${ID})\n\nZweiter Absatz.`)
    expect(editable.querySelectorAll('figure')).toHaveLength(1)
    let inside = ''
    handle.current!.withView((view) => (inside = view.state.selection.$from.parent.textContent))
    expect(inside).toBe('Zweiter Absatz.')
  })

  it('takes the place of an empty paragraph, and leaves a line to go on writing', async () => {
    const handle = createRef<DiaryEditorHandle>()
    await show('', handle)
    act(() => handle.current!.insertPhoto(ID))
    act(() => handle.current!.insertPhoto(OTHER))
    expect(markdown(handle)).toBe(`![](photo:${ID})\n\n![](photo:${OTHER})`)
    let parent = ''
    let count = 0
    handle.current!.withView((view) => {
      parent = view.state.selection.$from.parent.type.name
      count = view.state.doc.childCount
    })
    expect(parent).toBe('paragraph')
    expect(count).toBe(3)
  })

  it('writes a caption, as one line, with the characters of Markdown escaped', async () => {
    const handle = createRef<DiaryEditorHandle>()
    const changes: string[] = []
    const editable = await show(`![](photo:${ID})`, handle, undefined, (next) => changes.push(next))
    const field = editable.querySelector<HTMLInputElement>('figure input')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(field, 'Mia [und] Ben beim *Spiel*')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const written = markdown(handle)
    expect(written.split('\n')).toHaveLength(1)
    expect(written).toMatch(new RegExp(`^!\\[Mia \\\\\\[und\\\\\\] Ben beim \\\\\\*Spiel\\\\\\*\\]\\(photo:${ID}\\)$`))
    // And read again, it is the same caption.
    const again = createRef<DiaryEditorHandle>()
    act(() => root.unmount())
    box.remove()
    const second = await show(written, again)
    expect(second.querySelector<HTMLInputElement>('figure input')?.value).toBe('Mia [und] Ben beim *Spiel*')
  })

  it('moves a photo up and down and takes it out', async () => {
    const handle = createRef<DiaryEditorHandle>()
    const editable = await show(`Eins.\n\n![a](photo:${ID})\n\nZwei.\n\n![b](photo:${OTHER})`, handle)
    const tool = (figure: number, name: string) => editable.querySelectorAll('figure')[figure].querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
    await act(async () => tool(0, 'Nach oben').click())
    expect(markdown(handle)).toBe(`![a](photo:${ID})\n\nEins.\n\nZwei.\n\n![b](photo:${OTHER})`)
    await act(async () => tool(0, 'Nach oben').click())
    expect(markdown(handle).startsWith(`![a](photo:${ID})`)).toBe(true)
    await act(async () => tool(1, 'Nach unten').click())
    await act(async () => tool(0, 'Nach unten').click())
    expect(markdown(handle)).toBe(`Eins.\n\n![a](photo:${ID})\n\nZwei.\n\n![b](photo:${OTHER})`)
    await act(async () => tool(1, 'Nach unten').click())
    expect(markdown(handle).endsWith(`![b](photo:${OTHER})`)).toBe(true)
    await act(async () => tool(0, 'Bild entfernen').click())
    expect(markdown(handle)).toBe(`Eins.\n\nZwei.\n\n![b](photo:${OTHER})`)
    expect(editable.querySelectorAll('figure')).toHaveLength(1)
  })

  it('goes on in the text after the picture with Enter in the caption', async () => {
    const handle = createRef<DiaryEditorHandle>()
    const editable = await show(`![a](photo:${ID})\n\nDanach.`, handle)
    const field = editable.querySelector<HTMLInputElement>('figure input')!
    await act(async () => {
      field.focus()
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    let inside = ''
    handle.current!.withView((view) => (inside = view.state.selection.$from.parent.textContent))
    expect(inside).toBe('Danach.')
    expect(markdown(handle)).toBe(`![a](photo:${ID})\n\nDanach.`)
  })

  it('shows a quiet word for a photo that is gone', async () => {
    const editable = await show(`![a](photo:${ID})`)
    const img = editable.querySelector('figure img')!
    act(() => {
      img.dispatchEvent(new Event('error'))
    })
    expect(editable.querySelector('.diary-photo-gone')?.hasAttribute('hidden')).toBe(false)
    expect(editable.querySelector('.diary-photo-gone')?.textContent).toBe('Dieses Foto gibt es nicht mehr.')
    expect((img as HTMLElement).hidden).toBe(true)
  })

  it('takes no picture from a paste or a drop', async () => {
    const handle = createRef<DiaryEditorHandle>()
    const editable = await show('Anfang', handle)
    const html = `<figure data-photo="${ID}"><img src="/api/photos/${ID}"><figcaption>x</figcaption></figure><p><img src="${`/api/photos/${OTHER}`}"></p>`
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { types: ['text/html', 'text/plain'], files: [], getData: (type: string) => (type === 'text/html' ? html : 'x') } })
    await act(async () => {
      editable.focus()
      editable.dispatchEvent(paste)
    })
    // Nothing is to appear, so there is no event to wait for: the paste is handled in the turns it is given.
    await flush()
    await flush()
    expect(editable.querySelectorAll('figure, img')).toHaveLength(0)
    expect(markdown(handle)).not.toContain('photo:')
  })
})

describe('the button "Bild einfügen"', () => {
  const ways = (extra: Partial<ImageWays> = {}): ImageWays => ({ busy: false, onFile: () => undefined, ...extra })

  it('is not there without ways to bring a picture', async () => {
    await show('')
    expect(box.querySelector('[aria-label="Bild einfügen"]')).toBeNull()
  })

  it('offers the camera and a file always, and Immich and the photos of the day only where there are', async () => {
    await show('', createRef(), ways())
    const open = () => box.querySelector<HTMLButtonElement>('[aria-label="Bild einfügen"]')!
    expect(open().getAttribute('aria-expanded')).toBe('false')
    await act(async () => open().click())
    expect(open().getAttribute('aria-expanded')).toBe('true')
    expect([...box.querySelectorAll('[role=menuitem]')].map((item) => item.textContent?.trim())).toEqual(['Foto aufnehmen', 'Datei hochladen'])
    act(() => root.unmount())
    box.remove()
    await show('', createRef(), ways({ onImmich: () => undefined, onDay: () => undefined }))
    await act(async () => open().click())
    expect([...box.querySelectorAll('[role=menuitem]')].map((item) => item.textContent?.trim())).toEqual(['Foto aufnehmen', 'Datei hochladen', 'Aus Immich', 'Aus den Fotos dieses Tages'])
  })

  it('hands a chosen file on, takes its menu away, and calls the other ways', async () => {
    const got: File[] = []
    let immich = 0
    let day = 0
    await show('', createRef(), ways({ onFile: (file) => got.push(file), onImmich: () => immich++, onDay: () => day++ }))
    const open = () => box.querySelector<HTMLButtonElement>('[aria-label="Bild einfügen"]')!
    const inputs = [...box.querySelectorAll<HTMLInputElement>('input[type=file]')]
    expect(inputs.map((input) => input.getAttribute('capture'))).toEqual(['environment', null])
    expect(inputs.every((input) => input.accept === 'image/*')).toBe(true)
    const file = new File(['x'], 'foto.jpg', { type: 'image/jpeg' })
    Object.defineProperty(inputs[1], 'files', { value: [file], configurable: true })
    await act(async () => inputs[1].dispatchEvent(new Event('change', { bubbles: true })))
    expect(got).toEqual([file])
    await act(async () => open().click())
    await act(async () => [...box.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find((item) => item.textContent?.includes('Immich'))!.click())
    expect(immich).toBe(1)
    expect(box.querySelector('[role=menu]')).toBeNull()
    await act(async () => open().click())
    await act(async () => [...box.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find((item) => item.textContent?.includes('Fotos dieses Tages'))!.click())
    expect(day).toBe(1)
  })

  it('closes on Escape and on a press elsewhere, and is shut while a picture is on its way', async () => {
    await show('', createRef(), ways())
    const open = () => box.querySelector<HTMLButtonElement>('[aria-label="Bild einfügen"]')!
    await act(async () => open().click())
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(box.querySelector('[role=menu]')).toBeNull()
    await act(async () => open().click())
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(box.querySelector('[role=menu]')).toBeNull()
    act(() => root.unmount())
    box.remove()
    await show('', createRef(), ways({ busy: true }))
    expect(open().disabled).toBe(true)
  })
})
