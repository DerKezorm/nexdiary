/** A page of the diary as elements (`lib/markdown.ts` reads it): never HTML, so nothing written becomes markup. Should
 * reading it ever fail, the page shows the text as it was written, in paragraphs, instead of nothing. */
import { ImageOff } from 'lucide-react'
import { Component, Fragment, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { photoUrl } from '../api/client'
import { parseBlocks, type Block, type Inline } from '../lib/markdown'

/** Where the picture of a photo in the text comes from: the person's own photos, or the route of a shared day. */
export type PhotoSource = (id: string) => string

/** A picture inside a page: full width, with its caption. A photo that is gone (deleted since) shows a quiet
 * placeholder, never a broken image. */
function TextPhoto({ id, caption, source }: { id: string; caption: string; source: PhotoSource }) {
  const { t } = useTranslation()
  const [gone, setGone] = useState(false)
  return (
    <figure className="diary-photo" data-photo={id}>
      {gone ? (
        <div className="diary-photo-gone" role="img" aria-label={t('textPhoto.gone')}>
          <ImageOff size={18} aria-hidden /> {t('textPhoto.gone')}
        </div>
      ) : (
        <img src={source(id)} alt={caption} onError={() => setGone(true)} draggable={false} />
      )}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  )
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.kind === 'text') return <Fragment key={index}>{node.text}</Fragment>
    if (node.kind === 'break') return <br key={index} />
    if (node.kind === 'strong') return <strong key={index}>{renderInline(node.children)}</strong>
    return <em key={index}>{renderInline(node.children)}</em>
  })
}

function renderBlocks(nodes: Block[], source: PhotoSource): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case 'photo':
        return <TextPhoto key={index} id={node.id} caption={node.caption} source={source} />
      case 'paragraph':
        return <p key={index}>{renderInline(node.children)}</p>
      case 'heading':
        return <h2 key={index}>{renderInline(node.children)}</h2>
      case 'quote':
        return <blockquote key={index}>{renderBlocks(node.children, source)}</blockquote>
      case 'list': {
        const items = node.items.map((item, at) => <li key={at}>{renderBlocks(item, source)}</li>)
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

function Read({ text, className, source }: { text: string; className: string; source: PhotoSource }) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  return <div className={className}>{renderBlocks(blocks, source)}</div>
}

const OWN: PhotoSource = (id) => photoUrl(id)

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
export function Markdown({ text, className = 'prose-diary', photo = OWN }: { text: string; className?: string; photo?: PhotoSource }) {
  return (
    <Guard key={text} text={text} className={className}>
      <Read text={text} className={className} source={photo} />
    </Guard>
  )
}

