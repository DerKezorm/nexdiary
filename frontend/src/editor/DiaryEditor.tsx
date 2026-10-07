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
import type { EditorView } from '@milkdown/kit/prose/view'
import { Bold, Heading2, Italic, List, Quote, Undo2, type LucideIcon } from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { tame } from '../lib/markdown'
import { diaryPlugins, HEADING_LEVEL } from './setup'

export type DiaryEditorHandle = {
  /** A question as a subheading at the end, and the caret on a fresh line below it (the writing prompts). */
  insertHeading: (text: string) => void
  focus: () => void
  /** The caret at the very end of the text, in focus (to go on writing there). */
  moveToEnd: () => void
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

export function DiaryEditor({
  value,
  onChange,
  onEmptyChange,
  placeholder,
  label,
  toolbarHost,
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
  // The first text only: the editor is not controlled after it started.
  const first = useRef(value)
  const shownLabel = useRef(label)

  useEffect(() => {
    changed.current = onChange
    emptied.current = onEmptyChange
  }, [onChange, onEmptyChange])

  useEffect(() => {
    const element = root.current
    if (!element) return
    let gone = false
    let wasEmpty: boolean | null = null
    const look = (state: EditorState) => {
      setActive(activeOf(state))
      const now = state.doc.childCount <= 1 && state.doc.textContent.length === 0 && state.doc.firstChild?.type.name !== 'heading'
      setEmpty(now)
      if (now !== wasEmpty) {
        wasEmpty = now
        emptied.current?.(now)
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
        look(instance.ctx.get(editorViewCtx).state)
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
      <div role="toolbar" aria-label={t('editor.tools')} className={`${toolbarHost ? 'mb-2' : 'sticky top-14 z-10 -mx-1 mb-3 lg:top-0'} flex gap-0.5 rounded-full border border-line bg-sheet/95 p-1 backdrop-blur`}>
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
    </div>
  )
}

export default DiaryEditor
