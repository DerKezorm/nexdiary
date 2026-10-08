/**
 * Templates for the pages, on the side of the page being written: the scaffold a template puts into the editor, what
 * counts as "nothing written yet", which template a text was written under, and the empty sections that fall away when
 * the page is saved. Pure functions on Markdown text, tested without a browser.
 *
 * A section of a template is a heading of the page (`## Heading`) with a question the person wrote as a hint. The
 * headings are compared by their words in one normal form (`normalHeading`), as the server does when it makes the AI's
 * answer follow a template: the editor writes a heading with marks in it escaped (`C\#`), a node of the editor shows it
 * without the marks of bold or italic, and the template holds what the person typed. All three come out the same.
 */
import type { Template, TemplateSection } from '../api/client'

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/
/** A backslash before a mark of Markdown: the mark itself is meant. */
const ESCAPED = /\\([!-/:-@[-`{-~])/g
/** The marks that Markdown reads in a line, which a heading typed as it is must not let through. */
const MARKS = /[\\*_[\]<>`#~&]/g

/** The one normal form, of Markdown text (the words of a heading line as the editor or the model wrote them): escapes
 * resolved, the marks of bold, italic and code gone, white space collapsed, case out of the way. */
export function normalMarkdown(markdown: string): string {
  return markdown
    .replace(ESCAPED, '$1')
    .replace(/[*_`]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/** The same for a heading as the person typed it, or as a node of the editor shows it. It goes through the escaping
 * first, as it does when it is written into the text, so that a backslash of its own (`C:\Users`) is a backslash on
 * both ways. */
export function normalHeading(heading: string): string {
  return normalMarkdown(escapeHeading(heading))
}

/** A heading as the text of a Markdown heading line: every mark that Markdown would read is escaped, so that the editor
 * shows the words as the person typed them (`Was *wichtig* war` keeps its stars). */
export function escapeHeading(heading: string): string {
  return heading.replace(MARKS, '\\$&')
}

/** The words of a Markdown heading line (as written there, escapes included), or null for any other line. */
export function headingOf(line: string): string | null {
  const found = HEADING.exec(line)
  return found && found[1].trim() ? found[1].trim() : null
}

/** No more than one empty line in a row, nothing at either end: text compared without the editor's way of writing an
 * empty paragraph (it leaves two extra line breaks where Markdown has none). */
export function tidy(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]*(?:\n[ \t]*)+\n/g, '\n\n')
    .trim()
}

/** The text a template starts a page with: its headings, in order, each as a subheading. */
export function scaffold(sections: TemplateSection[]): string {
  return sections.map((section) => `## ${escapeHeading(section.heading)}`).join('\n\n')
}

/** Whether nothing of the person's is in the text: nothing at all, or exactly the headings of one of the templates, in
 * its order and with nothing under them (however the editor wrote them). */
export function untouchedText(text: string, templates: Template[]): boolean {
  const flat = tidy(text)
  if (flat === '') return true
  const found: string[] = []
  for (const line of flat.split('\n')) {
    if (!line.trim()) continue
    const words = headingOf(line)
    if (words === null) return false
    found.push(normalMarkdown(words))
  }
  return templates.some(
    (template) => template.sections.length === found.length && template.sections.every((section, at) => normalHeading(section.heading) === found[at]),
  )
}

/** The template a text was written under: the one whose headings stand most often in the text as subheadings (at least
 * one). A heading the person took away does not matter. A tie goes to the preferred one, then to the order of the list. */
export function templateOf(text: string, templates: Template[], preferred: string | null = null): Template | null {
  const found = new Set<string>()
  for (const line of text.split('\n')) {
    const words = headingOf(line)
    if (words) found.add(normalMarkdown(words))
  }
  let best: Template | null = null
  let most = 0
  for (const template of [...templates].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred))) {
    const score = template.sections.filter((section) => found.has(normalHeading(section.heading))).length
    if (score > most) {
      best = template
      most = score
    }
  }
  return best
}

/**
 * The text without its empty sections: a heading of the template under which nothing stands up to the next heading (only
 * empty lines) goes, with its empty lines. Headings of other words stay, empty or not, and so does everything that is
 * written. Nothing is changed in a text without such a section but the extra empty lines the editor leaves.
 */
export function withoutEmptySections(text: string, headings: string[]): string {
  const ours = new Set(headings.map(normalHeading))
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const kept: string[] = []
  for (let at = 0; at < lines.length; at++) {
    const words = headingOf(lines[at])
    if (words !== null && ours.has(normalMarkdown(words))) {
      let next = at + 1
      while (next < lines.length && lines[next].trim() === '') next++
      if (next >= lines.length || headingOf(lines[next]) !== null) {
        at = next - 1
        continue
      }
    }
    kept.push(lines[at])
  }
  return tidy(kept.join('\n'))
}
