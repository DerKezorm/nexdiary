/**
 * A page of the diary, shown. The page is Markdown in exactly the forms the editor writes (`editor/flatten.ts`):
 * paragraphs, subheadings, quotes, lists, bold and italic, line breaks. This reads those and nothing else, and builds
 * React elements from them: no HTML is ever parsed or set, so a `<script>` in a text, a title or a tag stays the text
 * it was written as. What Markdown knows beyond that (links, pictures, code) shows as its plain characters.
 *
 * Small on purpose: the editor (Milkdown) is the heaviest part of the app and is loaded only for writing. The
 * elements are made in `components/Markdown.tsx`.
 *
 * Linear in the length of the text, whatever is written: a text of somebody else (a shared day) must never freeze or
 * break the page that shows it. An opening mark looks for its closing one only where no earlier search of the same
 * kind found nothing (that is remembered), quotes and lists nest at most `MAX_DEPTH` deep (deeper, the characters
 * stand as text), and nothing recurses per character. Bold and italic need no such limit: an opener takes the first
 * closing mark of its kind, so an opener of the same kind inside finds none, and marks nest at most as deep as there
 * are kinds (`*`, `**`, `_`, `__`).
 *
 * One picture is known: `![caption](photo:<id>)` on a line of its own, the id of one of the person's own photos (the
 * server keeps only those), with a cut after the id when one was made (`#crop=…&rot=…`, `lib/textPhoto.ts`; a fragment
 * that is not exactly that form is no cut, the photo shows whole). Every other picture, an address or `data:` or
 * `photo:` anywhere else, is nothing but the characters it is written with and is never loaded.
 *
 * `tame` gives the same limits to the editor: its parser (remark) takes seconds or overflows the stack on such texts.
 */
import { cutOfAddress, formatFragment, isCut, type TextCut } from './textPhoto'

export type Inline ={ kind: 'text'; text: string } | { kind: 'break' } | { kind: 'strong' | 'em'; children: Inline[] }

export type Block =
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'heading'; children: Inline[] }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'photo'; id: string; caption: string; cut?: TextCut }

/** A picture of the page: a line holding nothing but `![caption](photo:<id>)`, a fragment after the id allowed (read
 * strictly afterwards, `cutOfAddress`). */
export const PHOTO_LINE = /^ {0,3}!\[((?:\\.|[^\]\\\n]){0,300})\]\(photo:([0-9a-f]{32})(#[^\s()\\]{0,200})?\)[ \t]*$/

/** How deep quotes and lists nest: deeper than any page is written, shallow enough for any stack. */
export const MAX_DEPTH = 20

const HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const QUOTE = /^ {0,3}> ?(.*)$/
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+(.*))?$/
const BLANK = /^[ \t]*$/
/** A dividing line: nothing to show. */
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
/** Characters Markdown lets a backslash escape. */
const PUNCTUATION = /[!-/:-@[-`{-~]/
const BACKSLASH = '\\'
const NEWLINE = '\n'
/** The characters that can mean something inside a block; everything else is taken in one piece. */
const SPECIAL = new Set([BACKSLASH, NEWLINE, '*', '_'])

function startsBlock(line: string): boolean {
  return HEADING.test(line) || QUOTE.test(line) || ITEM.test(line) || RULE.test(line)
}

/** Whether the last text read went deeper than the limits (and was read as text there). */
let capped = false

/** The blocks of a text. */
export function parseBlocks(markdown: string): Block[] {
  capped = false
  return blocks(markdown.replace(/\r\n?/g, NEWLINE).split(NEWLINE), 0)
}

function blocks(lines: string[], depth: number): Block[] {
  // As deep as a page may go: what lies deeper is its text, as written.
  if (depth >= MAX_DEPTH) capped = true
  if (depth >= MAX_DEPTH) return lines.some((line) => !BLANK.test(line)) ? [{ kind: 'paragraph', children: parseInline(lines.join(NEWLINE)) }] : []
  const out: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (BLANK.test(line)) {
      index++
      continue
    }
    if (RULE.test(line)) {
      index++
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ kind: 'heading', children: parseInline(heading[1] ?? '') })
      index++
      continue
    }
    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (index < lines.length && !BLANK.test(lines[index])) {
        const quoted = QUOTE.exec(lines[index])
        // A line without ">" right after quoted ones still belongs to the quote (a lazy continuation).
        if (!quoted && startsBlock(lines[index])) break
        inner.push(quoted ? quoted[1] : lines[index])
        index++
      }
      out.push({ kind: 'quote', children: blocks(inner, depth + 1) })
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      const [list, next] = parseList(lines, index, depth)
      out.push(list)
      index = next
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length && !BLANK.test(lines[index]) && (paragraph.length === 0 || !startsBlock(lines[index]))) {
      paragraph.push(lines[index])
      index++
    }
    // A picture stands alone in its paragraph, as the editor writes it; beside words it is just those characters.
    // Only at the top of the page, as in the editor: in a quote or a list it is the words of its caption.
    const picture = depth === 0 && paragraph.length === 1 ? PHOTO_LINE.exec(paragraph[0]) : null
    if (picture) {
      const cut = cutOfAddress(picture[3])
      const photo: Block = { kind: 'photo', id: picture[2], caption: unescapeText(picture[1]) }
      out.push(isCut(cut) ? { ...photo, cut } : photo)
    } else out.push({ kind: 'paragraph', children: parseInline(paragraph.join(NEWLINE)) })
  }
  return out
}

/** The characters a backslash stands before are themselves. */
function unescapeText(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

function parseList(lines: string[], from: number, depth: number): [Block, number] {
  const first = ITEM.exec(lines[from])!
  const ordered = /\d/.test(first[2])
  const start = ordered ? Number.parseInt(first[2], 10) : 1
  const items: Block[][] = []
  let index = from
  while (index < lines.length) {
    const item = ITEM.exec(lines[index])
    if (!item || /\d/.test(item[2]) !== ordered) break
    // The text of an item is indented by as much as its marker takes; lines indented that far belong to it.
    const width = item[1].length + item[2].length + 1
    const content: string[] = [item[4] ?? '']
    index++
    while (index < lines.length) {
      const line = lines[index]
      if (BLANK.test(line)) {
        // A blank line ends the item unless the next line goes on inside it.
        const after = lines[index + 1]
        if (after !== undefined && !BLANK.test(after) && indentOf(after) >= width) {
          content.push('')
          index++
          continue
        }
        break
      }
      if (indentOf(line) >= width) content.push(line.slice(width))
      else if (!startsBlock(line)) content.push(line.trimStart())
      else break
      index++
    }
    items.push(blocks(content, depth + 1))
    // A blank line between two items of the same list keeps the list going.
    if (index < lines.length && BLANK.test(lines[index]) && lines[index + 1] !== undefined) {
      const next = ITEM.exec(lines[index + 1])
      if (next && /\d/.test(next[2]) === ordered && next[1].length < width) index++
    }
  }
  return [{ kind: 'list', ordered, start, items }, index]
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** Text as it is gathered: pieces in a list and the spaces at its end counted, so nothing is copied again and again. */
class Gathered {
  private pieces: string[] = []
  private trailing = 0

  add(piece: string): void {
    if (!piece) return
    this.pieces.push(piece)
    let spaces = 0
    while (spaces < piece.length && piece[piece.length - 1 - spaces] === ' ') spaces++
    this.trailing = spaces === piece.length ? this.trailing + spaces : spaces
  }

  /** Drops the spaces at the end; says how many there were. */
  trimEnd(): number {
    const dropped = this.trailing
    let left = dropped
    while (left > 0 && this.pieces.length) {
      const last = this.pieces[this.pieces.length - 1]
      const cut = Math.min(left, last.length)
      left -= cut
      if (cut === last.length) this.pieces.pop()
      else this.pieces[this.pieces.length - 1] = last.slice(0, last.length - cut)
    }
    this.trailing = 0
    return dropped
  }

  take(): string {
    const text = this.pieces.join('')
    this.pieces = []
    this.trailing = 0
    return text
  }
}

/** Bold, italic, line breaks and escaped characters in one block of text. */
export function parseInline(text: string): Inline[] {
  return inline(text, 0, text.length)
}

function inline(text: string, from: number, to: number): Inline[] {
  const out: Inline[] = []
  const plain = new Gathered()
  const flush = () => {
    const piece = plain.take()
    if (piece) out.push({ kind: 'text', text: piece })
  }
  /** By kind of mark: the place from which a search for a closing mark found nothing. A later search from further on
   * sees fewer candidates and would find nothing either, so it is not made. */
  const nothingFrom = new Map<string, number>()
  let index = from
  while (index < to) {
    const char = text[index]
    if (char === BACKSLASH && index + 1 < to) {
      const next = text[index + 1]
      if (next === NEWLINE) {
        flush()
        out.push({ kind: 'break' })
        index += 2
        continue
      }
      if (PUNCTUATION.test(next)) {
        plain.add(next)
        index += 2
        continue
      }
    }
    if (char === NEWLINE) {
      // Two spaces before the end of a line make a break; any other line end is a space.
      if (plain.trimEnd() >= 2) {
        flush()
        out.push({ kind: 'break' })
      } else plain.add(' ')
      index++
      continue
    }
    if (char === '*' || char === '_') {
      const run = runLength(text, index, to, char)
      const size = run >= 2 ? 2 : 1
      const key = char + size
      const nothing = nothingFrom.get(key)
      let close = -1
      if (canOpen(text, index, index + run, char) && (nothing === undefined || index + size < nothing)) {
        close = findClose(text, index + size, to, char, size)
        if (close < 0) nothingFrom.set(key, index + size)
      }
      if (close > index + size) {
        flush()
        out.push({ kind: size === 2 ? 'strong' : 'em', children: inline(text, index + size, close) })
        index = close + size
        continue
      }
      plain.add(text.slice(index, index + run))
      index += run
      continue
    }
    // Plain characters up to the next one that may mean something, in one piece.
    let end = index + 1
    while (end < to && !SPECIAL.has(text[end])) end++
    plain.add(text.slice(index, end))
    index = end
  }
  flush()
  return out
}

function runLength(text: string, at: number, to: number, char: string): number {
  let end = at
  while (end < to && text[end] === char) end++
  return end - at
}

const SPACE = /\s/
const WORD = /[\p{L}\p{N}]/u

function canOpen(text: string, at: number, after: number, char: string): boolean {
  const next = text[after]
  if (next === undefined || SPACE.test(next)) return false
  // An underscore inside a word ("snake_case") is the character itself.
  return !(char === '_' && at > 0 && WORD.test(text[at - 1]))
}

function findClose(text: string, from: number, to: number, char: string, size: number): number {
  let index = from
  while (index < to) {
    if (text[index] === BACKSLASH) {
      index += 2
      continue
    }
    if (text[index] === char) {
      const run = runLength(text, index, to, char)
      const before = text[index - 1]
      const after = text[index + run]
      const closes = before !== undefined && !SPACE.test(before) && !(char === '_' && after !== undefined && WORD.test(after))
      if (closes && (run === size || (size === 1 && run === 3) || (size === 2 && run >= 2))) return index
      index += run
      continue
    }
    index++
  }
  return -1
}

/** A page as plain words in one line (the marks gone), for comparing and for short lists. Walks without recursion. */
export function plainText(markdown: string): string {
  const words: string[] = []
  const stack: (Block | Inline)[] = [...parseBlocks(markdown)].reverse()
  while (stack.length) {
    const node = stack.pop()!
    switch (node.kind) {
      case 'text':
        words.push(node.text)
        break
      case 'break':
        words.push(' ')
        break
      case 'strong':
      case 'em':
        for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
        break
      case 'paragraph':
      case 'heading':
        words.push(' ')
        for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
        break
      case 'photo':
        words.push(' ')
        break
      case 'quote':
        words.push(' ')
        for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
        break
      case 'list':
        words.push(' ')
        for (let i = node.items.length - 1; i >= 0; i--) for (let j = node.items[i].length - 1; j >= 0; j--) stack.push(node.items[i][j])
        break
    }
  }
  return words.join('').replace(/\s+/g, ' ').trim()
}

/** Every ASCII punctuation character: escaped with a backslash, each stands for itself in Markdown. */
const ESCAPABLE = /[!-/:-@[-`{-~]/g

function escapeText(text: string): string {
  return text.replace(ESCAPABLE, (char) => BACKSLASH + char)
}

/** Marks of bold and italic still to write in `tame`; beyond them the words stand without. */
let marksLeft = 0

function inlineMarkdown(nodes: Inline[]): string {
  const out: string[] = []
  const stack: (Inline | string)[] = [...nodes].reverse()
  while (stack.length) {
    const node = stack.pop()!
    if (typeof node === 'string') out.push(node)
    else if (node.kind === 'text') out.push(escapeText(node.text))
    else if (node.kind === 'break') out.push(BACKSLASH + NEWLINE)
    else {
      const mark = marksLeft > 0 ? (node.kind === 'strong' ? '**' : '*') : ''
      marksLeft -= 2
      stack.push(mark)
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
      out.push(mark)
    }
  }
  return out.join('')
}

function blockMarkdown(nodes: Block[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'paragraph':
          // Spaces at its start would make a paragraph code to the editor.
          return inlineMarkdown(node.children).trimStart()
        case 'photo':
          return `![${escapeText(node.caption)}](photo:${node.id}${formatFragment(node.cut)})`
        case 'heading':
          return '## ' + inlineMarkdown(node.children)
        case 'quote':
          return blockMarkdown(node.children)
            .split(NEWLINE)
            .map((line) => (line ? '> ' + line : '>'))
            .join(NEWLINE)
        case 'list':
          return node.items
            .map((item, index) => {
              const marker = node.ordered ? `${node.start + index}. ` : '- '
              const pad = ' '.repeat(marker.length)
              return blockMarkdown(item)
                .split(NEWLINE)
                .map((line, at) => (at === 0 ? marker + line : line ? pad + line : ''))
                .join(NEWLINE)
            })
            .join(NEWLINE)
      }
    })
    .join(NEWLINE + NEWLINE)
}

/**
 * The text for the editor: unchanged as long as it stays within the limits (every page the editor wrote does);
 * otherwise written anew from what is read here, everything beyond the limits as escaped text. The editor's own
 * parser then meets nothing deeper than a page can be, and is quick.
 */
export function tame(markdown: string): string {
  const read = parseBlocks(markdown)
  if (!capped && countMarks(markdown) <= MAX_MARKS) return markdown
  marksLeft = MAX_MARKS
  return blockMarkdown(read)
}

/** How many marks of bold and italic the editor gets. Its parser pairs them up in a time that grows with their square
 * (`*a* ` written 25,000 times took 3 s, `*_` minutes); a text with more is written anew, the marks beyond these
 * dropped (the words stay). Far more than any page has. */
export const MAX_MARKS = 1000

function countMarks(markdown: string): number {
  let count = 0
  for (let index = 0; index < markdown.length; index++) {
    const char = markdown[index]
    if (char === BACKSLASH) index++
    else if (char === '*' || char === '_') count++
  }
  return count
}

/** The photos a page shows inside its text, in order, each once (the ones that stand on a line of their own). */
export function textPhotoIds(markdown: string): string[] {
  const ids = parseBlocks(markdown).flatMap((block) => (block.kind === 'photo' ? [block.id] : []))
  return [...new Set(ids)]
}
