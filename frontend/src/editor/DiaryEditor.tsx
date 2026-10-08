/**
 * The page of a day being written, as the mock's `Editor.tsx`: a round bar (bold, italic, subheading, quote, list,
 * undo) that stays in view while scrolling, and below it the text in the diary's serif. Redo is on the keyboard
 * (Ctrl+Y, Ctrl+Shift+Z, Cmd+Shift+Z).
 *
 * Markdown goes in and comes out (`onChange`); the editor itself is not controlled after it started: a new text from
 * outside (another version loaded) is a new editor (`key`).
 */
import { commandsCtx, defaultValueCtx, Editor, editorViewCtx, editorViewOptionsCtx, rootCtx, type CommandManager } from '@milkdown/kit/core'
import { history, undoCommand } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import {
  liftListItemCommand,
  toggleEmphasisCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
} from '@milkdown/kit/preset/commonmark'
import { lift } from '@milkdown/kit/prose/commands'
import { $prose, getMarkdown } from '@milkdown/kit/utils'
import type { EditorState } from '@milkdown/kit/prose/state'
import { Plugin, PluginKey, Selection, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { Bold, Camera, Heading2, ImagePlus, Images, Italic, List, Loader2, Quote, Undo2, Upload, type LucideIcon } from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { photoUrl, type TemplateSection } from '../api/client'
import { TextCropDialog } from '../components/CropEditor'
import { PHOTO_ACCEPT } from '../lib/upload'
import { tame } from '../lib/markdown'
import { normalHeading } from '../lib/templates'
import { CUT_EVENT, insertPhoto, type CutRequest } from './photo'
import { diaryPlugins, HEADING_LEVEL } from './setup'

export type DiaryEditorHandle = {
  /** A question as a subheading at the end, and the caret on a fresh line below it (the writing prompts). */
  insertHeading: (text: string) => void
  focus: () => void
  /** The caret at the very end of the text, in focus (to go on writing there). */
  moveToEnd: () => void
  /** A photo of the person's own into the text where the caret is, as a block of its own with a caption. */
  insertPhoto: (id: string) => void
  /** The view of the editor for whoever must reach into it: the page, and the tests with their key presses. */
  withView: (action: (view: EditorView) => void) => void
  /** The text as it stands this moment. `onChange` comes a little after the typing (Milkdown waits for a pause);
   * whoever saves asks here, so the last words typed before a tap on "Save" are not lost. */
  getMarkdown: () => string | null
}

type Active = { bold: boolean; italic: boolean; heading: boolean; quote: boolean; list: boolean }
const NOTHING: Active = { bold: false, italic: false, heading: false, quote: false, list: false }

function within(state: EditorState, name: string): boolean {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === name) return true
  return false
}

function markActive(state: EditorState, name: string): boolean {
  const type = state.schema.marks[name]
  if (!type) return false
  const { from, to, empty, $from } = state.selection
  if (empty) return Boolean(type.isInSet(state.storedMarks ?? $from.marks()))
  return state.doc.rangeHasMark(from, to, type)
}

function activeOf(state: EditorState): Active {
  return {
    bold: markActive(state, 'strong'),
    italic: markActive(state, 'emphasis'),
    heading: state.selection.$from.parent.type.name === 'heading',
    quote: within(state, 'blockquote'),
    list: within(state, 'bullet_list') || within(state, 'ordered_list'),
  }
}

/** Whether a document holds nothing of the person's but the headings of a template and empty paragraphs. */
function onlyScaffold(state: EditorState, headings: Set<string>): boolean {
  let blank = true
  state.doc.forEach((node) => {
    if (node.type.name === 'paragraph' && node.childCount === 0) return
    if (node.type.name === 'heading' && headings.has(normalHeading(node.textContent))) return
    blank = false
  })
  return blank
}

/** An empty paragraph under every heading of the template that has none (a heading followed by a heading, or the last
 * one), so there is a line to write on. Not part of the history: undo does not take it away again. */
function fillGaps(view: EditorView, headings: Set<string>): void {
  const { doc, schema } = view.state
  const at: number[] = []
  doc.forEach((node, offset, index) => {
    if (node.type.name !== 'heading' || !headings.has(normalHeading(node.textContent))) return
    const next = index + 1 < doc.childCount ? doc.child(index + 1) : null
    if (!next || next.type.name === 'heading') at.push(offset + node.nodeSize)
  })
  if (at.length === 0) return
  let tr = view.state.tr
  for (const position of at.reverse()) tr = tr.insert(position, schema.nodes.paragraph.create())
  view.dispatch(tr.setMeta('addToHistory', false))
}

/** The ways the button "Image" offers: a photo from the device (the camera, a file), from the own Immich, from the photos
 * of the day. A way that is left out is not offered. */
export type ImageWays = {
  busy: boolean
  onFile: (file: File) => void
  onImmich?: () => void
  onDay?: () => void
}

export function DiaryEditor({
  value,
  onChange,
  onEmptyChange,
  placeholder,
  label,
  toolbarHost,
  images,
  sections,
  ref,
}: {
  value: string
  onChange: (markdown: string) => void
  /** Whether the page is empty, at once with every keystroke (``onChange`` waits for a pause in the typing). */
  onEmptyChange?: (empty: boolean) => void
  placeholder: string
  label: string
  /** Where the bar of formats goes (the page's sticky top bar, so that both stay in view together). Left out, it
   * stands above the text and keeps to the top on its own while the page scrolls. */
  toolbarHost?: HTMLElement | null
  /** Where a picture in the text may come from; left out, the bar has no button for it. */
  images?: ImageWays
  /** The sections of the template the page is written under: the headings get a line to write on, the question of a
   * section is shown grey in the empty line below its heading (no text of the page), and the page counts as empty while
   * it holds nothing but these headings. Read once, when the editor starts: another template is another editor. */
  sections?: TemplateSection[] | null
  ref?: Ref<DiaryEditorHandle>
}) {
  const { t } = useTranslation()
  const root = useRef<HTMLDivElement>(null)
  const editor = useRef<Editor | null>(null)
  const changed = useRef(onChange)
  const emptied = useRef(onEmptyChange)
  const [empty, setEmpty] = useState(!value.trim())
  const [active, setActive] = useState<Active>(NOTHING)
  const [ready, setReady] = useState(false)
  /** The photo of the text whose cut is being chosen ("Zuschneiden" on its block). */
  const [cutting, setCutting] = useState<CutRequest | null>(null)
  // The first text only: the editor is not controlled after it started.
  const first = useRef(value)
  const shownLabel = useRef(label)
  const template = useRef(sections)

  useEffect(() => {
    changed.current = onChange
    emptied.current = onEmptyChange
  }, [onChange, onEmptyChange])

  useEffect(() => {
    const element = root.current
    if (!element) return
    let gone = false
    let wasEmpty: boolean | null = null
    const headings = new Set((template.current ?? []).map((section) => normalHeading(section.heading)))
    const hints = new Map((template.current ?? []).filter((section) => section.question).map((section) => [normalHeading(section.heading), section.question]))
    const look = (state: EditorState) => {
      setActive(activeOf(state))
      const now = state.doc.childCount <= 1 && state.doc.textContent.length === 0 && state.doc.firstChild?.type.name !== 'heading'
      setEmpty(now)
      // With a template the page is empty while it holds only the template's own headings.
      const blank = headings.size > 0 ? onlyScaffold(state, headings) : now
      if (blank !== wasEmpty) {
        wasEmpty = blank
        emptied.current?.(blank)
      }
    }
    /** Every change of the document or the selection, as it happens: the bar's state, the placeholder, "empty". */
    const watching = $prose(
      () =>
        new Plugin({
          key: new PluginKey('DIARY_WATCH'),
          view: () => ({
            update: (view) => {
              if (!gone) look(view.state)
            },
          }),
        }),
    )
    /** The question of a section in the empty line below its heading: a decoration, drawn by the style, not in the text. */
    const asking = $prose(
      () =>
        new Plugin({
          key: new PluginKey('DIARY_SECTION_HINTS'),
          props: {
            decorations: (state) => {
              if (hints.size === 0) return null
              const found: Decoration[] = []
              state.doc.forEach((node, offset, index) => {
                if (index === 0 || node.type.name !== 'paragraph' || node.childCount !== 0) return
                const before = state.doc.child(index - 1)
                const question = before.type.name === 'heading' ? hints.get(normalHeading(before.textContent)) : undefined
                if (question) found.push(Decoration.node(offset, offset + node.nodeSize, { class: 'diary-hint', 'data-hint': question }))
              })
              return DecorationSet.create(state.doc, found)
            },
          },
        }),
    )
    const made = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, element)
        // Within the limits a page has: remark needs seconds, or overflows its stack, on texts made to do that.
        ctx.set(defaultValueCtx, tame(first.current))
        ctx.update(editorViewOptionsCtx, (options) => ({
          ...options,
          // The caret stays clear of the sticky bars: the top bar and the editor's own above, "Save" below on a phone.
          scrollMargin: { top: 130, bottom: 110, left: 5, right: 5 },
          scrollThreshold: { top: 130, bottom: 110, left: 5, right: 5 },
          attributes: {
            class: 'prose-diary min-h-64 outline-none',
            role: 'textbox',
            'aria-multiline': 'true',
            'aria-label': shownLabel.current,
            spellcheck: 'true',
          },
        }))
        ctx
          .get(listenerCtx)
          .markdownUpdated((_ctx, markdown) => {
            if (!gone) changed.current(markdown)
          })
      })
      .use(diaryPlugins)
      .use(watching)
      .use(asking)
      .use(history)
      .use(listener)
    made
      .create()
      .then((instance) => {
        if (gone) {
          void instance.destroy()
          return
        }
        editor.current = instance
        const view = instance.ctx.get(editorViewCtx)
        if (headings.size > 0) fillGaps(view, headings)
        look(view.state)
        setReady(true)
      })
      .catch(() => undefined)
    return () => {
      gone = true
      const instance = editor.current
      editor.current = null
      if (instance) void instance.destroy()
    }
  }, [])

  // "Zuschneiden" on a photo's block asks here; the dialog answers it.
  useEffect(() => {
    const element = root.current
    if (!element) return
    const asked = (event: Event) => {
      const request = (event as CustomEvent<CutRequest>).detail
      if (request && typeof request.apply === 'function') setCutting(request)
    }
    element.addEventListener(CUT_EVENT, asked)
    return () => element.removeEventListener(CUT_EVENT, asked)
  }, [])

  const run = (action: (commands: CommandManager) => void) => {
    const instance = editor.current
    if (!instance) return
    instance.action((ctx) => {
      action(ctx.get(commandsCtx))
      const view = ctx.get(editorViewCtx)
      view.focus()
      setActive(activeOf(view.state))
    })
  }

  const withView = (action: (view: EditorView) => void) => {
    editor.current?.action((ctx) => action(ctx.get(editorViewCtx)))
  }

  useImperativeHandle(ref, () => ({
    focus: () => withView((view) => view.focus()),
    moveToEnd: () =>
      withView((view) => {
        view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)).scrollIntoView())
        view.focus()
      }),
    withView,
    insertPhoto: (id: string) => withView((view) => insertPhoto(view, id)),
    getMarkdown: () => {
      const instance = editor.current
      return instance ? instance.action(getMarkdown()).replace(/\s+$/, '') : null
    },
    insertHeading: (text: string) =>
      withView((view) => {
        const { schema } = view.state
        const heading = schema.nodes.heading.create({ level: HEADING_LEVEL }, schema.text(text))
        const paragraph = schema.nodes.paragraph.create()
        const end = view.state.doc.content.size
        let tr = view.state.tr.insert(end, [heading, paragraph])
        tr = tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1)).scrollIntoView()
        view.dispatch(tr)
        view.focus()
      }),
  }))

  const tools: { icon: LucideIcon; label: string; on: boolean; run: () => void }[] = [
    { icon: Bold, label: t('editor.bold'), on: active.bold, run: () => run((c) => c.call(toggleStrongCommand.key)) },
    { icon: Italic, label: t('editor.italic'), on: active.italic, run: () => run((c) => c.call(toggleEmphasisCommand.key)) },
    {
      icon: Heading2,
      label: t('editor.heading'),
      on: active.heading,
      run: () => run((c) => (active.heading ? c.call(turnIntoTextCommand.key) : c.call(wrapInHeadingCommand.key, HEADING_LEVEL))),
    },
    {
      icon: Quote,
      label: t('editor.quote'),
      on: active.quote,
      run: () =>
        active.quote
          ? withView((view) => {
              lift(view.state, view.dispatch)
              view.focus()
              setActive(activeOf(view.state))
            })
          : run((c) => c.call(wrapInBlockquoteCommand.key)),
    },
    { icon: List, label: t('editor.list'), on: active.list, run: () => run((c) => (active.list ? c.call(liftListItemCommand.key) : c.call(wrapInBulletListCommand.key))) },
    { icon: Undo2, label: t('editor.undo'), on: false, run: () => run((c) => c.call(undoCommand.key)) },
  ]

  const bar = (
      <div role="toolbar" aria-label={t('editor.tools')} className={`${toolbarHost ? 'mb-2' : 'sticky top-14 z-10 -mx-1 mb-3 lg:top-0'} relative flex gap-0.5 rounded-full border border-line bg-sheet/95 p-1 backdrop-blur`}>
        {tools.map(({ icon: Icon, label: name, on, run: act }) => (
          <button
            key={name}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={act}
            disabled={!ready}
            title={name}
            aria-label={name}
            aria-pressed={name === t('editor.undo') ? undefined : on}
            className={`rounded-full p-2 hover:bg-sheet-2 hover:text-ink ${on ? 'bg-accent-soft text-accent' : 'text-ink-2'}`}
          >
            <Icon size={17} />
          </button>
        ))}
        {images && <ImageButton ways={images} ready={ready} />}
      </div>
  )

  return (
    <div>
      {toolbarHost ? createPortal(bar, toolbarHost) : bar}
      <div className="relative">
        {empty && (
          <div aria-hidden className="prose-diary pointer-events-none absolute inset-0 text-muted">
            {placeholder}
          </div>
        )}
        <div ref={root} data-diary-editor />
      </div>
      {cutting && (
        <TextCropDialog
          src={photoUrl(cutting.id, true)}
          value={cutting.cut}
          onClose={() => setCutting(null)}
          onDone={(cut) => {
            const request = cutting
            setCutting(null)
            request.apply(cut)
          }}
        />
      )}
    </div>
  )
}

export default DiaryEditor

/** The button "Image" of the bar and the small menu under it. The device's file (and the camera) go through hidden
 * fields; the other ways are the page's business. */
function ImageButton({ ways, ready }: { ways: ImageWays; ready: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const holder = useRef<HTMLSpanElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (!holder.current?.contains(event.target as Node)) setOpen(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  const item = (icon: LucideIcon, label: string, act: () => void) => {
    const Icon = icon
    return (
      <button
        key={label}
        type="button"
        role="menuitem"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setOpen(false)
          act()
        }}
        className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm font-semibold text-ink-2 hover:bg-sheet-2 hover:text-ink"
      >
        <Icon size={16} aria-hidden /> {label}
      </button>
    )
  }
  const pick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0]
    event.target.value = ''
    if (chosen) ways.onFile(chosen)
  }
  return (
    <span ref={holder} className="relative inline-flex">
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
        disabled={!ready || ways.busy}
        title={t('editor.image')}
        aria-label={t('editor.image')}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`rounded-full p-2 hover:bg-sheet-2 hover:text-ink ${open ? 'bg-accent-soft text-accent' : 'text-ink-2'}`}
      >
        {ways.busy ? <Loader2 size={17} className="animate-spin" aria-hidden /> : <ImagePlus size={17} />}
      </button>
      {open && (
        <div role="menu" aria-label={t('editor.image')} className="card absolute top-full right-0 z-30 mt-2 w-64 p-1.5 shadow-soft" data-image-menu>
          {item(Camera, t('editor.imageCamera'), () => camera.current?.click())}
          {item(Upload, t('editor.imageFile'), () => file.current?.click())}
          {ways.onImmich && item(Images, t('editor.imageImmich'), ways.onImmich)}
          {ways.onDay && item(ImagePlus, t('editor.imageDay'), ways.onDay)}
        </div>
      )}
      <input ref={camera} type="file" accept={PHOTO_ACCEPT} capture="environment" className="hidden" aria-label={t('editor.imageCamera')} onChange={pick} />
      <input ref={file} type="file" accept={PHOTO_ACCEPT} className="hidden" aria-label={t('editor.imageFile')} onChange={pick} />
    </span>
  )
}
