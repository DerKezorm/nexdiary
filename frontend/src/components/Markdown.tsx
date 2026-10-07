/** A page of the diary as elements (`lib/markdown.ts` reads it): never HTML, so nothing written becomes markup. Should
 * reading it ever fail, the page shows the text as it was written, in paragraphs, instead of nothing. */
import { Component, Fragment, useMemo, type ReactNode } from 'react'

import { parseBlocks, type Block, type Inline } from '../lib/markdown'

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.kind === 'text') return <Fragment key={index}>{node.text}</Fragment>
    if (node.kind === 'break') return <br key={index} />
    if (node.kind === 'strong') return <strong key={index}>{renderInline(node.children)}</strong>
    return <em key={index}>{renderInline(node.children)}</em>
  })
}

function renderBlocks(nodes: Block[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'paragraph':
        return <p key={index}>{renderInline(node.children)}</p>
      case 'heading':
        return <h2 key={index}>{renderInline(node.children)}</h2>
      case 'quote':
        return <blockquote key={index}>{renderBlocks(node.children)}</blockquote>
      case 'list': {
        const items = node.items.map((item, at) => <li key={at}>{renderBlocks(item)}</li>)
        return node.ordered ? (
          <ol key={index} start={node.start === 1 ? undefined : node.start}>
            {items}
          </ol>
        ) : (
          <ul key={index}>{items}</ul>
        )
      }
    }
  })
}

function Read({ text, className }: { text: string; className: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  return <div className={className}>{renderBlocks(blocks)}</div>
}

/** The text as it was written, a paragraph per blank line: what shows when reading it failed. */
export function Raw({ text, className }: { text: string; className: string }) {
  return (
    <div className={className}>
      {text.split(/\n\s*\n/).map((part, index) => (
        <p key={index} className="whitespace-pre-line">
          {part}
        </p>
      ))}
    </div>
  )
}

/** Catches a failure while the page is read or drawn and shows the text as written instead. A new text starts afresh
 * (`key`). */
class Guard extends Component<{ text: string; className: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (this.state.failed) return <Raw text={this.props.text} className={this.props.className} />
    return this.props.children
  }
}

/** A page as elements, for `.prose-diary`. */
export function Markdown({ text, className = 'prose-diary' }: { text: string; className?: string }) {
  return (
    <Guard key={text} text={text} className={className}>
      <Read text={text} className={className} />
    </Guard>
  )
}

