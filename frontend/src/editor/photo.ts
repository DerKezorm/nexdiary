/**
 * A picture inside the page: one of the person's own photos as a block of its own, full width, with a caption that
 * can be written beside it. In the Markdown it is exactly `![caption](photo:<id>)` on a line of its own and nothing
 * else (`flatten.ts` turns every other picture into plain words; the server keeps only the photos of the person and
 * the day). The block is an atom: it is moved with the two arrows, taken out with the third button or with Backspace
 * and Delete once selected, and cannot be typed into, pasted or dropped in; only the "Image" button of the bar and a tap
 * on a photo of the day put one in (`insertPhoto`).
 *
 * A cut (`#crop=…&rot=…` after the id, `lib/textPhoto.ts`) is kept in the attribute `cut` as its canonical fragment
 * without `#`; the tool "Zuschneiden" asks the page for it (the event `diary-photo-cut`, which `DiaryEditor` answers
 * with its dialog). The picture shows the cut out of the original; the file is never changed.
 */
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'
import { $nodeSchema, $remark, $view } from '@milkdown/kit/utils'
import i18next from 'i18next'

import { photoUrl } from '../api/client'
import { cutLayout, formatFragment, NO_CUT, parseFragment, ratioValue, type TextCut } from '../lib/textPhoto'

export const PHOTO_NODE = 'diary_photo'
/** A caption is a line, not a paragraph. */
export const CAPTION_MAX = 300

type PhotoMarkdown = { id?: string; alt?: string | null; cut?: unknown }

/** The picture as the writer of Markdown gets it: written as an image, the cut put in afterwards as it is. remark
 * would escape the `&` of `crop=…&rot=…` (`\&`), and the server keeps only the exact form. */
const PHOTO_MARKDOWN = 'diaryPhotoImage'

type Handle = (node: Record<string, unknown>, parent: unknown, state: unknown, info: unknown) => string
type Writer = { handle: Handle }

function writePhoto(node: Record<string, unknown>, parent: unknown, state: unknown, info: unknown): string {
  const id = typeof node.id === 'string' ? node.id : ''
  const alt = typeof node.alt === 'string' ? node.alt : ''
  const image = (state as Writer).handle({ type: 'image', url: `photo:${id}`, alt, title: null }, parent, state, info)
  const fragment = formatFragment(cutOf(node.cut))
  return fragment && image.endsWith(')') ? `${image.slice(0, -1)}${fragment})` : image
}

export const photoMarkdown = $remark('diaryPhotoMarkdown', () =>
  function (this: { data: (key: string, value?: unknown) => unknown }) {
    const extensions = (this.data('toMarkdownExtensions') as unknown[] | undefined) ?? []
    this.data('toMarkdownExtensions', [...extensions, { handlers: { [PHOTO_MARKDOWN]: writePhoto } }])
  } as never,
)

/** The name of the event the block sends when "Zuschneiden" is pressed. */
export const CUT_EVENT = 'diary-photo-cut'
/** What comes with it: the photo, its cut, and how to put a new cut on the block. */
export type CutRequest = { id: string; cut: TextCut; apply: (cut: TextCut) => void }

/** The cut an attribute holds; anything but a canonical fragment is none. */
export function cutOf(attribute: unknown): TextCut {
  return typeof attribute === 'string' ? (parseFragment(attribute) ?? NO_CUT) : NO_CUT
}

export const photoSchema = $nodeSchema(PHOTO_NODE, () => ({
  group: 'block',
  atom: true,
  isolating: true,
  selectable: true,
  draggable: false,
  attrs: { id: { default: '', validate: 'string' }, caption: { default: '', validate: 'string' }, cut: { default: '', validate: 'string' } },
  // Nothing pasted becomes a picture: the HTML of another page has no way into this node.
  parseDOM: [],
  toDOM: (node: ProseNode) => ['figure', { class: 'diary-photo', 'data-photo': node.attrs.id }, ['img', { src: photoUrl(node.attrs.id), alt: node.attrs.caption }]],
  parseMarkdown: {
    match: (node: { type: string }) => node.type === 'diaryPhoto',
    runner: (state, node, type) => {
      const found = node as unknown as PhotoMarkdown
      state.addNode(type, { id: found.id ?? '', caption: (found.alt ?? '').slice(0, CAPTION_MAX), cut: formatFragment(cutOf(found.cut)).slice(1) })
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === PHOTO_NODE,
    runner: (state, node) => {
      state.openNode('paragraph')
      state.addNode(PHOTO_MARKDOWN, undefined, undefined, { id: node.attrs.id, alt: node.attrs.caption, cut: node.attrs.cut })
      state.closeNode()
    },
  },
}))

const ICONS = {
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  remove: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  cut: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
}

/** Shows the cut of `img` inside `frame` once the picture's size is known; no cut, the picture as it is. */
export function showCut(frame: HTMLElement, img: HTMLImageElement, cut: TextCut): void {
  const layout = cutLayout(img.naturalWidth, img.naturalHeight, cut)
  frame.classList.toggle('diary-photo-cut', layout !== null)
  if (layout) frame.style.setProperty('--cut-ratio', ratioValue(layout.ratio))
  else frame.style.removeProperty('--cut-ratio')
  img.removeAttribute('style')
  if (!layout) return
  for (const [name, value] of Object.entries(layout.img)) img.style.setProperty(name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`), String(value))
}

function tool(kind: keyof typeof ICONS, label: string, act: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-label', label)
  // Static markup of our own, never text that was written.
  button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[kind]}</svg>`
  button.addEventListener('mousedown', (event) => event.preventDefault())
  button.addEventListener('click', (event) => {
    event.preventDefault()
    act()
  })
  return button
}

/** The block as the editor shows it: the picture, three tools, the caption as a field. */
export const photoView = $view(photoSchema.node, () => (node, view, getPos): NodeView => {
  let current = node
  const dom = document.createElement('figure')
  dom.className = 'diary-photo diary-photo-edit'
  dom.dataset.photo = node.attrs.id
  dom.contentEditable = 'false'

  const gone = document.createElement('div')
  gone.className = 'diary-photo-gone'
  gone.hidden = true
  gone.textContent = i18next.t('textPhoto.gone')
  const img = document.createElement('img')
  img.src = photoUrl(node.attrs.id)
  img.alt = ''
  img.draggable = false
  img.addEventListener('error', () => {
    frame.hidden = true
    img.hidden = true
    gone.hidden = false
  })
  // The cut out of the original, as the page shows it.
  const frame = document.createElement('span')
  frame.className = 'diary-photo-frame'
  frame.append(img)
  img.addEventListener('load', () => showCut(frame, img, cutOf(current.attrs.cut)))

  const at = () => {
    const found = getPos()
    return typeof found === 'number' ? found : null
  }
  const remove = () => {
    const pos = at()
    if (pos === null) return
    view.dispatch(view.state.tr.delete(pos, pos + current.nodeSize).scrollIntoView())
    view.focus()
  }
  const move = (direction: -1 | 1) => {
    const pos = at()
    if (pos === null) return
    const { doc } = view.state
    const size = current.nodeSize
    const neighbour = direction < 0 ? doc.resolve(pos).nodeBefore : doc.resolve(pos + size).nodeAfter
    if (!neighbour) return
    let tr = view.state.tr.delete(pos, pos + size)
    tr = tr.insert(direction < 0 ? pos - neighbour.nodeSize : pos + neighbour.nodeSize, current)
    view.dispatch(tr.scrollIntoView())
    view.focus()
  }

  const cutting = () => {
    const request: CutRequest = {
      id: current.attrs.id,
      cut: cutOf(current.attrs.cut),
      apply: (cut) => {
        const pos = at()
        if (pos === null) return
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, cut: formatFragment(cut).slice(1) }))
      },
    }
    dom.dispatchEvent(new CustomEvent<CutRequest>(CUT_EVENT, { bubbles: true, detail: request }))
  }

  const tools = document.createElement('div')
  tools.className = 'diary-photo-tools'
  tools.append(
    tool('up', i18next.t('textPhoto.up'), () => move(-1)),
    tool('down', i18next.t('textPhoto.down'), () => move(1)),
    tool('cut', i18next.t('editor.crop.open'), cutting),
    tool('remove', i18next.t('textPhoto.remove'), remove),
  )

  const caption = document.createElement('input')
  caption.type = 'text'
  caption.maxLength = CAPTION_MAX
  caption.value = node.attrs.caption
  caption.placeholder = i18next.t('textPhoto.caption')
  caption.setAttribute('aria-label', i18next.t('textPhoto.caption'))
  caption.addEventListener('input', () => {
    const pos = at()
    if (pos === null) return
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, caption: caption.value.replace(/[\r\n]+/g, ' ') }))
  })
  caption.addEventListener('keydown', (event) => {
    // Enter leaves the caption for the text after the picture.
    if (event.key !== 'Enter' || event.isComposing) return
    event.preventDefault()
    const pos = at()
    if (pos === null) return
    after(view, pos + current.nodeSize)
  })

  dom.append(frame, gone, tools, caption)

  return {
    dom,
    update: (next) => {
      if (next.type !== current.type || next.attrs.id !== current.attrs.id) return false
      const recut = next.attrs.cut !== current.attrs.cut
      current = next
      if (document.activeElement !== caption) caption.value = next.attrs.caption
      if (recut && img.complete && img.naturalWidth > 0) showCut(frame, img, cutOf(next.attrs.cut))
      return true
    },
    selectNode: () => dom.classList.add('ProseMirror-selectednode'),
    deselectNode: () => dom.classList.remove('ProseMirror-selectednode'),
    // Its own buttons and field are not the editor's business; the editor's selection is not theirs.
    stopEvent: (event) => event.target instanceof Node && (tools.contains(event.target) || caption === event.target),
    ignoreMutation: () => true,
  }
})

/** The caret in the text that follows the picture ending at `pos`: the paragraph there, or a new one. */
function after(view: EditorView, pos: number): void {
  const { state } = view
  let tr = state.tr
  const next = state.doc.resolve(pos).nodeAfter
  let target = pos + 1
  if (!next || !next.isTextblock) {
    tr = tr.insert(pos, state.schema.nodes.paragraph.create())
    target = pos + 1
  }
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, target)).scrollIntoView())
  view.focus()
}

/**
 * Puts a photo into the text where the caret is: in place of an empty paragraph, else after the block the caret is
 * in; the caret goes on in the text below it. The photo is the person's own (the server removes any other when the
 * page is saved).
 */
export function insertPhoto(view: EditorView, id: string): void {
  const { state } = view
  const type = state.schema.nodes[PHOTO_NODE]
  if (!type) return
  const { $from } = state.selection
  const blank = $from.depth === 1 && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0
  const from = blank ? $from.before(1) : $from.depth >= 1 ? $from.after(1) : state.doc.content.size
  const to = blank ? $from.after(1) : from
  const photo = type.create({ id, caption: '', cut: '' })
  const tr = state.tr.replaceWith(from, to, photo)
  view.dispatch(tr)
  after(view, from + photo.nodeSize)
}
