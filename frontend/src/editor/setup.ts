/**
 * The diary's editor: Milkdown as in nexlore, cut down to what the bar of the mock offers. Paragraphs, subheadings,
 * quotes, lists, bold and italic; undo and redo. No links, no pictures, no code, no tables, no raw HTML: what Markdown
 * would otherwise make of them is turned into text (`flatten.ts`) before it reaches the page.
 *
 * Pasting brings text and those formats only: the schema has nothing else to take (ProseMirror's own parser keeps what
 * the schema knows), files pasted or dropped are ignored, Milkdown's clipboard plugin is not used (it creates code
 * blocks for text from code editors, a node this schema does not have).
 *
 * Every node of a transaction is recognised by its name, never with `instanceof`: in the bundle ProseMirror's classes
 * can exist twice, and `instanceof` then fails without a word (nexlore, 01.10.2026).
 */
import { commandsCtx } from '@milkdown/kit/core'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import {
  blockContainerTypes,
  blockquoteAttr,
  blockquoteKeymap,
  blockquoteSchema,
  bulletListAttr,
  bulletListKeymap,
  bulletListSchema,
  docSchema,
  emphasisAttr,
  emphasisKeymap,
  emphasisSchema,
  emphasisStarInputRule,
  emphasisUnderscoreInputRule,
  hardbreakAttr,
  hardbreakClearMarkPlugin,
  hardbreakFilterNodes,
  hardbreakFilterPlugin,
  hardbreakKeymap,
  hardbreakSchema,
  headingAttr,
  headingIdGenerator,
  headingSchema,
  inlineNodesCursorPlugin,
  insertHardbreakCommand,
  liftFirstListItemCommand,
  liftListItemCommand,
  listItemAttr,
  listItemKeymap,
  listItemSchema,
  orderedListAttr,
  orderedListKeymap,
  orderedListSchema,
  paragraphAttr,
  paragraphKeymap,
  paragraphSchema,
  remarkAddOrderInListPlugin,
  remarkLineBreak,
  remarkMarker,
  setBlockTypeCommand,
  sinkListItemCommand,
  splitListItemCommand,
  strongAttr,
  strongInputRule,
  strongKeymap,
  strongSchema,
  syncListOrderPlugin,
  textSchema,
  toggleEmphasisCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBlockquoteInputRule,
  wrapInBlockTypeCommand,
  wrapInBulletListCommand,
  wrapInBulletListInputRule,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
  wrapInOrderedListInputRule,
} from '@milkdown/kit/preset/commonmark'
import { textblockTypeInputRule } from '@milkdown/kit/prose/inputrules'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { $inputRule, $prose, $remark, $useKeymap } from '@milkdown/kit/utils'

import { remarkFlatten } from './flatten'

/** The only heading a page has: the subheading (the title of the day stands above the text, outside it). */
export const HEADING_LEVEL = 2

const flattenRemark = $remark('diaryFlatten', () => remarkFlatten as never)

/** "## " (or any number of #) at the start of a line makes a subheading. */
const headingInputRule = $inputRule((ctx) =>
  textblockTypeInputRule(/^#{1,6}\s$/, headingSchema.type(ctx), () => ({ level: HEADING_LEVEL })),
)

/** Mod-Alt-2 turns the line into a subheading, Mod-Alt-0 back into text. */
const headingKeymap = $useKeymap('diaryHeadingKeymap', {
  TurnIntoSubheading: {
    shortcuts: 'Mod-Alt-2',
    command: (ctx) => {
      const commands = ctx.get(commandsCtx)
      return () => commands.call(wrapInHeadingCommand.key, HEADING_LEVEL)
    },
  },
})

/** A heading of another level (pasted from a web page, say) becomes a subheading at once. */
const oneHeadingLevel = $prose(
  () =>
    new Plugin({
      key: new PluginKey('DIARY_ONE_HEADING_LEVEL'),
      appendTransaction: (transactions, _old, state) => {
        if (!transactions.some((tr) => tr.docChanged)) return null
        let tr = state.tr
        let changed = false
        state.doc.descendants((node, pos) => {
          if (node.type.name === 'heading' && node.attrs.level !== HEADING_LEVEL) {
            tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, level: HEADING_LEVEL })
            changed = true
          }
        })
        return changed ? tr : null
      },
    }),
)

/** Strips the wrapper Google Docs puts around everything it copies (its `<b>` would make all of it bold). */
export function cleanPastedHtml(html: string): string {
  if (!html.includes('docs-internal-guid')) return html
  return html.replace(/<b[^>]*id="docs-internal-guid[^"]*"[^>]*>([\s\S]*)<\/b>/, '$1')
}

/** A paste that brings nothing but files (a screenshot, a photo copied from a file manager): taken by nobody, not
 * even by the browser, which would put the picture into the page on its own. */
export function onlyFilesPasted(data: Pick<DataTransfer, 'getData' | 'files'> | null): boolean {
  if (!data) return false
  const words = data.getData('text/plain') || data.getData('text/html')
  return !words && data.files.length > 0
}

/** Files dropped onto the page are not taken either: photos go through "Fotos" and the cover. */
export function filesDropped(event: Pick<DragEvent, 'dataTransfer'>): boolean {
  return Boolean(event.dataTransfer?.files.length)
}

const onlyText = $prose(
  () =>
    new Plugin({
      key: new PluginKey('DIARY_ONLY_TEXT'),
      props: {
        transformPastedHTML: cleanPastedHtml,
        handlePaste: (_view, event) => onlyFilesPasted(event.clipboardData),
        handleDrop: (_view, event) => filesDropped(event as DragEvent),
      },
    }),
)

/** The parts that keep a page to text: tested to be in the editor. */
export const textOnly = onlyText

export const diaryPlugins: MilkdownPlugin[] = [
  flattenRemark,
  docSchema,
  paragraphAttr,
  paragraphSchema,
  headingIdGenerator,
  headingAttr,
  headingSchema,
  hardbreakAttr,
  hardbreakSchema,
  blockquoteAttr,
  blockquoteSchema,
  bulletListAttr,
  bulletListSchema,
  orderedListAttr,
  orderedListSchema,
  listItemAttr,
  listItemSchema,
  textSchema,
  emphasisAttr,
  emphasisSchema,
  strongAttr,
  strongSchema,

  wrapInBlockquoteInputRule,
  wrapInBulletListInputRule,
  wrapInOrderedListInputRule,
  headingInputRule,
  emphasisStarInputRule,
  emphasisUnderscoreInputRule,
  strongInputRule,

  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInHeadingCommand,
  insertHardbreakCommand,
  wrapInOrderedListCommand,
  wrapInBulletListCommand,
  sinkListItemCommand,
  splitListItemCommand,
  liftListItemCommand,
  liftFirstListItemCommand,
  toggleEmphasisCommand,
  toggleStrongCommand,
  setBlockTypeCommand,
  wrapInBlockTypeCommand,

  blockquoteKeymap,
  hardbreakKeymap,
  listItemKeymap,
  orderedListKeymap,
  bulletListKeymap,
  paragraphKeymap,
  emphasisKeymap,
  strongKeymap,
  headingKeymap,

  hardbreakClearMarkPlugin,
  hardbreakFilterNodes,
  hardbreakFilterPlugin,
  inlineNodesCursorPlugin,
  blockContainerTypes,
  remarkAddOrderInListPlugin,
  remarkLineBreak,
  remarkMarker,
  syncListOrderPlugin,
  oneHeadingLevel,
  onlyText,
].flat()
