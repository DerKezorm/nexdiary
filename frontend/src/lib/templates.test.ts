/**
 * The side of a template that needs no page: the frame it puts into the text, what counts as nothing written yet, which
 * template a text was written under, and the empty sections that fall away on saving. Headings with marks of Markdown in
 * them (`C#`, `Plan [A]`, `Was *wichtig* war`) are compared in one normal form, whether typed, written by the editor
 * with the marks escaped, or shown by a node of the editor.
 */
import type { Template } from '../api/client'
import { escapeHeading, headingOf, normalHeading, normalMarkdown, scaffold, templateOf, tidy, untouchedText, withoutEmptySections } from './templates'

const REVIEW: Template = {
  id: 'aaaaaaaaaaaa',
  name: 'Tagesrückblick',
  sections: [
    { heading: 'Heute', question: 'Was war heute los?' },
    { heading: 'Schönes', question: '' },
    { heading: 'C#', question: '' },
  ],
}
const WORK: Template = { id: 'bbbbbbbbbbbb', name: 'Arbeitstag', sections: [{ heading: 'Heute', question: '' }, { heading: 'Gehakt', question: '' }] }
const HEADS = REVIEW.sections.map((section) => section.heading)

describe('headings', () => {
  it('are read from a line the way the server reads them', () => {
    expect(headingOf('## Heute')).toBe('Heute')
    expect(headingOf('### Heute ##')).toBe('Heute')
    expect(headingOf('  # C#')).toBe('C#')
    expect(headingOf('####### zu tief')).toBeNull()
    expect(headingOf('#nein')).toBeNull()
    expect(headingOf('> ## Zitat')).toBeNull()
    expect(headingOf('##')).toBeNull()
    expect(headingOf('Text')).toBeNull()
  })

  it('are compared by their words', () => {
    expect(normalHeading('  Was   WAR schön? ')).toBe('was war schön?')
    expect(normalHeading('**Heute**')).toBe(normalHeading('heute'))
    expect(normalHeading('_Heute_ ')).toBe('heute')
  })
})

describe('the frame', () => {
  it('is the headings, in order, as subheadings', () => {
    expect(scaffold(REVIEW.sections)).toBe('## Heute\n\n## Schönes\n\n## C\\#')
  })

  it("counts as nothing written, and so does nothing at all, with the editor's extra line breaks too", () => {
    expect(untouchedText('', [REVIEW])).toBe(true)
    expect(untouchedText('  \n ', [])).toBe(true)
    expect(untouchedText('## Heute\n\n## Schönes\n\n## C#', [REVIEW, WORK])).toBe(true)
    expect(untouchedText('## Heute\n\n\n\n## Schönes\n\n\n\n## C\\#\n\n', [REVIEW])).toBe(true)
    expect(untouchedText('## Heute\n\n## Gehakt', [REVIEW, WORK])).toBe(true)
    expect(untouchedText('## Heute\n\n## Gehakt', [REVIEW])).toBe(false)
    expect(untouchedText('## Heute\n\nEtwas.\n\n## Schönes\n\n## C#', [REVIEW])).toBe(false)
    expect(untouchedText('Text', [REVIEW])).toBe(false)
  })
})

describe('the template a text was written under', () => {
  it('is the one whose headings stand most often in it, the preferred one first on a tie', () => {
    const text = '## Heute\n\nEtwas.\n\n## Schönes\n\n## C#\n\nMehr.\n\n## Gehakt'
    // Three headings of the review against two of the work day.
    expect(templateOf(text, [WORK, REVIEW])?.id).toBe(REVIEW.id)
    expect(templateOf('## Heute\n\n## Gehakt', [REVIEW, WORK])?.id).toBe(WORK.id)
    // A tie: the preferred first, else the order of the list.
    expect(templateOf('## Heute', [REVIEW, WORK])?.id).toBe(REVIEW.id)
    expect(templateOf('## Heute', [WORK, REVIEW])?.id).toBe(WORK.id)
    expect(templateOf('## Heute', [REVIEW, WORK], WORK.id)?.id).toBe(WORK.id)
    expect(templateOf('## heute\n\n## SCHÖNES ##\n\n## c#', [REVIEW])?.id).toBe(REVIEW.id)
  })

  it('does not need every heading: one the person took away does not matter, but one has to be there', () => {
    expect(templateOf('## Heute\n\nEtwas.', [REVIEW])?.id).toBe(REVIEW.id)
    expect(templateOf('## Eigenes\n\nEtwas.', [REVIEW])).toBeNull()
    expect(templateOf('Nur Text.', [REVIEW, WORK])).toBeNull()
    expect(templateOf('', [REVIEW, WORK])).toBeNull()
    expect(templateOf('## Heute', [])).toBeNull()
  })
})

describe('saving', () => {
  it('drops the sections that stayed empty and keeps what is written', () => {
    expect(withoutEmptySections('## Heute\n\nEtwas.\n\n## Schönes\n\n## C#', HEADS)).toBe('## Heute\n\nEtwas.')
    expect(withoutEmptySections('## Heute\n\n## Schönes\n\nSchön.\n\n## C#\n\nCode.', HEADS)).toBe('## Schönes\n\nSchön.\n\n## C#\n\nCode.')
    expect(withoutEmptySections('## Heute\n\n## Schönes\n\n## C#', HEADS)).toBe('')
  })

  it("counts empty lines, also the editor's extra ones, as nothing", () => {
    expect(withoutEmptySections('## Heute\n\n\n\n## Schönes\n\n\n\nText\n\n\n\n## C#\n\n\n', HEADS)).toBe('## Schönes\n\nText')
    expect(withoutEmptySections('## Heute\n \n\t\n## Schönes\n\nText', HEADS)).toBe('## Schönes\n\nText')
  })

  it("keeps every other heading, empty or not, and the text before the first", () => {
    const text = 'Vorweg.\n\n## Heute\n\n## Eigenes\n\n## Schönes\n\n### Noch mehr\n\nText'
    expect(withoutEmptySections(text, HEADS)).toBe('Vorweg.\n\n## Eigenes\n\n### Noch mehr\n\nText')
  })

  it('takes anything but a blank line for writing: a list, a quote, a picture, a line of bold text', () => {
    const photo = `![Mia](photo:${'c'.repeat(32)})`
    for (const body of ['- eins', '> Zitat', photo, '**Fremd**', '#nein', '1. eins']) {
      expect(withoutEmptySections(`## Heute\n\n${body}\n\n## Schönes`, HEADS)).toBe(`## Heute\n\n${body}`)
    }
  })

  it('compares the words of a heading, not its look, and does nothing to a text without such sections', () => {
    expect(withoutEmptySections('## HEUTE ##\n\n## **Schönes**\n\n## c#', HEADS)).toBe('')
    expect(withoutEmptySections('Ein Satz.\n\nNoch einer.', HEADS)).toBe('Ein Satz.\n\nNoch einer.')
    expect(withoutEmptySections('## Heute\r\n\r\nText\r\n\r\n## Schönes', HEADS)).toBe('## Heute\n\nText')
    expect(withoutEmptySections('## Heute\n\nText', [])).toBe('## Heute\n\nText')
  })

  it('leaves what is saved the same when saved again', () => {
    const once = withoutEmptySections('## Heute\n\nEtwas.\n\n## Schönes\n\n## C#\n\nMehr.', HEADS)
    expect(withoutEmptySections(once, HEADS)).toBe(once)
  })

  it('still drops the empty sections of a template that is only partly there, and keeps all other headings', () => {
    const text = '## Heute\n\n## Eigenes\n\n## Dankbar\n\nJa.\n\n## Schönes'
    expect(withoutEmptySections(text, ['Heute', 'Schönes', 'Dankbar', 'Beschäftigt'])).toBe('## Eigenes\n\n## Dankbar\n\nJa.')
  })
})

describe('tidy', () => {
  it('leaves one empty line at most and nothing at the ends', () => {
    expect(tidy('\n\na\n\n\n\nb\n \n \nc  \n\n')).toBe('a\n\nb\n\nc')
    expect(tidy('a\n\nb')).toBe('a\n\nb')
  })
})

/** Headings with marks of Markdown in them: as a person types them, and as the editor writes them into the Markdown
 * (a mark escaped with a backslash; bold, italic and code written as what they are). */
const MARKED: { typed: string; written: string; shown: string }[] = [
  { typed: 'C#', written: 'C\\#', shown: 'C#' },
  { typed: 'Plan [A]', written: 'Plan \\[A]', shown: 'Plan [A]' },
  { typed: 'Dank_ und _mehr', written: 'Dank\\_ und \\_mehr', shown: 'Dank_ und _mehr' },
  { typed: 'a * b', written: 'a \\* b', shown: 'a * b' },
  { typed: 'Was *wichtig* war', written: 'Was *wichtig* war', shown: 'Was wichtig war' },
  { typed: 'Tag & <b>', written: 'Tag & \\<b>', shown: 'Tag & <b>' },
]
const MARKED_TEMPLATE: Template = { id: 'cccccccccccc', name: 'Zeichen', sections: MARKED.map(({ typed }) => ({ heading: typed, question: '' })) }
const WRITTEN = MARKED.map(({ written }) => `## ${written}`)

describe('headings with marks of Markdown in them', () => {
  it('come out the same as typed, as the editor writes them and as a node of the editor shows them', () => {
    for (const { typed, written, shown } of MARKED) {
      expect(normalMarkdown(written), typed).toBe(normalHeading(typed))
      expect(normalHeading(shown), typed).toBe(normalHeading(typed))
    }
    expect(normalHeading('Was *wichtig* war')).toBe('was wichtig war')
    expect(normalHeading(`a${BS}_b`)).not.toBe(normalHeading('ab'))
  })

  it('go into the frame as text, with every mark escaped, not as bold or italic', () => {
    expect(escapeHeading('Was *wichtig* war')).toBe('Was \\*wichtig\\* war')
    expect(escapeHeading('C#')).toBe('C\\#')
    expect(escapeHeading('Tag & <b>')).toBe('Tag \\& \\<b\\>')
    expect(escapeHeading('Heute')).toBe('Heute')
    // Read back as the heading it was made from.
    for (const { typed } of MARKED) expect(normalMarkdown(headingOf(scaffold([{ heading: typed, question: '' }]))!), typed).toBe(normalHeading(typed))
  })

  it('are dropped when empty, in the way the editor writes them, and kept with writing', () => {
    const everyone = MARKED_TEMPLATE.sections.map((section) => section.heading)
    expect(withoutEmptySections(WRITTEN.join('\n\n\n\n'), everyone)).toBe('')
    for (let at = 0; at < WRITTEN.length; at++) {
      const lines = WRITTEN.map((line, index) => (index === at ? `${line}\n\nGeschrieben.` : line))
      expect(withoutEmptySections(lines.join('\n\n\n\n'), everyone), MARKED[at].typed).toBe(`${WRITTEN[at]}\n\nGeschrieben.`)
    }
  })

  it('count as nothing written in either form, and as the frame of their template', () => {
    expect(untouchedText(scaffold(MARKED_TEMPLATE.sections), [MARKED_TEMPLATE])).toBe(true)
    expect(untouchedText(WRITTEN.join('\n\n\n\n'), [MARKED_TEMPLATE])).toBe(true)
    expect(untouchedText(`${WRITTEN.join('\n\n')}\n\nText`, [MARKED_TEMPLATE])).toBe(false)
    expect(untouchedText('## C\\#', [MARKED_TEMPLATE])).toBe(false)
  })

  it('are recognised again as their template after the page is opened anew', () => {
    const text = MARKED.map(({ written }, at) => (at % 2 ? `## ${written}\n\nEtwas.` : `## ${written}`)).join('\n\n')
    expect(templateOf(text, [REVIEW, WORK, MARKED_TEMPLATE])?.id).toBe(MARKED_TEMPLATE.id)
  })
})

/** Headings with a backslash of their own: a path, a backslash before a mark, two of them, a backslash before a hash. */
const BS = String.fromCharCode(92)
const OWN = [`C:${BS}Users${BS}*`, `a${BS}_b`, `${BS}${BS}`, `a ${BS}#`]
const OWN_TEMPLATE: Template = { id: 'dddddddddddd', name: 'Eigene', sections: OWN.map((heading) => ({ heading, question: '' })) }

describe('headings with a backslash of their own', () => {
  it('are written with the backslash escaped too, and read back as the heading they are', () => {
    const written = [`## C:${BS}${BS}Users${BS}${BS}${BS}*`, `## a${BS}${BS}${BS}_b`, `## ${BS}${BS}${BS}${BS}`, `## a ${BS}${BS}${BS}#`]
    expect(scaffold(OWN_TEMPLATE.sections)).toBe(written.join('\n\n'))
    for (const heading of OWN) expect(normalMarkdown(headingOf(scaffold([{ heading, question: '' }]))!), heading).toBe(normalHeading(heading))
    // Two headings that differ only by a backslash are two headings.
    expect(normalHeading(`a${BS}_b`)).not.toBe(normalHeading('ab'))
    expect(normalHeading(`a${BS}_b`)).not.toBe(normalHeading('a_b'))
  })

  it('count as the frame, are dropped when empty and kept with writing', () => {
    const frame = scaffold(OWN_TEMPLATE.sections)
    expect(untouchedText(frame, [OWN_TEMPLATE])).toBe(true)
    expect(untouchedText(frame.split('\n\n').join('\n\n\n\n'), [OWN_TEMPLATE])).toBe(true)
    expect(withoutEmptySections(frame, OWN)).toBe('')
    for (let at = 0; at < OWN.length; at++) {
      const lines = frame.split('\n\n').map((line, index) => (index === at ? `${line}\n\nGeschrieben.` : line))
      expect(withoutEmptySections(lines.join('\n\n'), OWN), OWN[at]).toBe(`${frame.split('\n\n')[at]}\n\nGeschrieben.`)
    }
    expect(templateOf(`${frame}\n\nText`, [REVIEW, OWN_TEMPLATE])?.id).toBe(OWN_TEMPLATE.id)
  })
})
