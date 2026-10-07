/**
 * What a page may hold: raw HTML, links, pictures and code become text before the editor sees them, a heading of any
 * level becomes a subheading, dividers go. Run on the Markdown tree, as remark makes it.
 */
import { flatten, type MdNode } from './flatten'

const text = (value: string): MdNode => ({ type: 'text', value })
const paragraph = (...children: MdNode[]): MdNode => ({ type: 'paragraph', children })
const root = (...children: MdNode[]): MdNode => ({ type: 'root', children })

function types(node: MdNode): string[] {
  return [node.type, ...(node.children ?? []).flatMap(types)]
}

describe('flatten', () => {
  it('turns raw HTML into the text it is written with, inline and as a block', () => {
    const tree = flatten(root(paragraph(text('a '), { type: 'html', value: '<img src=x onerror=alert(1)>' }), { type: 'html', value: '<script>alert(1)</script>' }))
    expect(tree).toEqual(root(paragraph(text('a '), text('<img src=x onerror=alert(1)>')), paragraph(text('<script>alert(1)</script>'))))
  })

  it('keeps the words of a link and of a picture, never their address', () => {
    const tree = flatten(
      root(
        paragraph({ type: 'link', url: 'javascript:alert(1)', children: [{ type: 'strong', children: [text('klick')] }] }, { type: 'image', url: 'http://example.com/p.png', alt: 'Bild' }),
        { type: 'link', url: 'javascript:alert(2)', children: [text('lose')] },
      ),
    )
    expect(JSON.stringify(tree)).not.toContain('javascript')
    expect(JSON.stringify(tree)).not.toContain('example.com')
    expect(tree).toEqual(root(paragraph({ type: 'strong', children: [text('klick')] }, text('Bild')), paragraph(text('lose'))))
  })

  it('makes code text, any heading a subheading, and drops dividers and definitions', () => {
    const tree = flatten(
      root(
        { type: 'heading', depth: 1, children: [text('Groß')] },
        { type: 'code', value: 'rm -rf /', lang: 'sh' },
        paragraph({ type: 'inlineCode', value: 'x()' }),
        { type: 'thematicBreak' },
        { type: 'definition', url: 'javascript:alert(3)', identifier: 'a' },
      ),
    )
    expect(tree).toEqual(root({ type: 'heading', depth: 2, children: [text('Groß')] }, paragraph(text('rm -rf /')), paragraph(text('x()'))))
  })

  it('keeps what the bar offers as it is', () => {
    const page = root(
      paragraph({ type: 'emphasis', children: [text('kursiv')] }, { type: 'break' }, text('weiter')),
      { type: 'blockquote', children: [paragraph(text('Zitat'))] },
      { type: 'list', ordered: false, children: [{ type: 'listItem', children: [paragraph(text('eins'))] }] },
    )
    expect(flatten(page)).toEqual(page)
  })

  it('leaves nothing but allowed nodes, however deep', () => {
    const tree = flatten(
      root({ type: 'blockquote', children: [{ type: 'list', children: [{ type: 'listItem', children: [{ type: 'html', value: '<b>x</b>' }, paragraph({ type: 'linkReference', children: [text('y')] })] }] }] }),
    )
    for (const type of types(tree)) expect(['root', 'paragraph', 'heading', 'blockquote', 'list', 'listItem', 'text', 'strong', 'emphasis', 'break']).toContain(type)
  })
})
