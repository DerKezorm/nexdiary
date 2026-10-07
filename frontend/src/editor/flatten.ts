/**
 * What a page of the diary may hold, as Markdown: paragraphs, subheadings, quotes, lists, bold and italic, line
 * breaks. Everything else that Markdown knows is turned into plain text before the editor sees it (or dropped, where
 * it is nothing but form):
 *
 * - **raw HTML** (`<img src=x onerror=…>`) becomes the text it is written with, never an element;
 * - **links and pictures** become their words (`[a](javascript:…)` is "a"); a picture is never loaded from anywhere.
 *   The one exception is a paragraph of nothing but `![caption](photo:<id>)` at the top of the page: the person's own
 *   photo as a block of its own (`photo.ts`). `photo:` is no address a browser could load; the server keeps only ids of
 *   the person's own photos of the day;
 * - code becomes text, a heading of any level a subheading, a dividing line nothing.
 *
 * Pure functions on the Markdown tree (mdast), so they are tested without a browser. The same pass runs on what is
 * loaded, on what is pasted as Markdown and on what an assistant writes later.
 */

export type MdNode = {
  type: string
  value?: string
  depth?: number
  alt?: string | null
  children?: MdNode[]
  [key: string]: unknown
}

const KEPT = new Set(['root', 'paragraph', 'heading', 'blockquote', 'list', 'listItem', 'text', 'strong', 'emphasis', 'break'])
/** Nodes that hold blocks: a stray inline node inside them is put into a paragraph. */
const HOLDS_BLOCKS = new Set(['root', 'blockquote', 'listItem'])
const BLOCKS = new Set(['paragraph', 'heading', 'blockquote', 'list', 'diaryPhoto'])
/** The one address a picture may have: a photo of the person, by its id. */
const PHOTO_URL = /^photo:[0-9a-f]{32}$/
/** Form without words: gone. */
const DROPPED = new Set(['thematicBreak', 'definition', 'footnoteDefinition', 'yaml', 'toml'])

function textOf(node: MdNode): string {
  if (typeof node.value === 'string') return node.value
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
  return (node.children ?? []).map(textOf).join('')
}

/** The node as one or more allowed nodes. */
function clean(node: MdNode, parent: string): MdNode[] {
  if (DROPPED.has(node.type)) return []
  if (node.type === 'paragraph' && parent === 'root' && node.children?.length === 1) {
    const only = node.children[0]
    if (only.type === 'image' && typeof only.url === 'string' && PHOTO_URL.test(only.url)) {
      return [{ type: 'diaryPhoto', id: only.url.slice('photo:'.length), alt: only.alt ?? '' }]
    }
  }
  if (KEPT.has(node.type)) {
    const out: MdNode = { ...node }
    if (node.type === 'heading') out.depth = 2
    if (node.children) out.children = cleanChildren(node.children, node.type)
    return [out]
  }
  // Links keep their words, with whatever bold or italic they had inside.
  if ((node.type === 'link' || node.type === 'linkReference') && node.children) return cleanChildren(node.children, parent)
  const words = textOf(node)
  if (!words) return []
  if (HOLDS_BLOCKS.has(parent)) return [{ type: 'paragraph', children: [{ type: 'text', value: words }] }]
  return [{ type: 'text', value: words }]
}

function cleanChildren(children: MdNode[], parent: string): MdNode[] {
  const out = children.flatMap((child) => clean(child, parent))
  if (!HOLDS_BLOCKS.has(parent)) return out
  // Inline nodes left directly in a block container (a link at the top) go into a paragraph of their own.
  const blocks: MdNode[] = []
  let loose: MdNode[] = []
  const flush = () => {
    if (loose.length) blocks.push({ type: 'paragraph', children: loose })
    loose = []
  }
  for (const child of out) {
    if (BLOCKS.has(child.type)) {
      flush()
      blocks.push(child)
    } else loose.push(child)
  }
  flush()
  return blocks
}

/** The tree with only what a page may hold. */
export function flatten(tree: MdNode): MdNode {
  return { ...tree, children: cleanChildren(tree.children ?? [], 'root') }
}

/** The same as a remark plugin (``unified().use(remarkFlatten)``): changes the tree in place. */
export function remarkFlatten() {
  return (tree: MdNode) => {
    tree.children = flatten(tree).children
  }
}
