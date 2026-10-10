/**
 * What another app shared into nexdiary (the share target of the manifest): `title`, `text` and `url`, each as the
 * sharing app chose. One text for the quick note, nothing said twice: many apps put the link into the text as well, some
 * the title.
 */
export type SharedParts = { title?: unknown; text?: unknown; url?: unknown }

export function joinShared(parts: SharedParts, limit = 5000): string {
  const out: string[] = []
  for (const value of [parts.title, parts.text, parts.url]) {
    const clean = typeof value === 'string' ? value.trim() : ''
    if (clean && !out.some((part) => part.includes(clean))) out.push(clean)
  }
  return out.join('\n').slice(0, limit)
}

/** A share as an address (`?title=…&text=…&url=…`): how an installed app shared before the share target took photos,
 * and how it still does until the phone has read the new manifest. */
export function sharedText(search: string, limit = 5000): string {
  const params = new URLSearchParams(search)
  return joinShared({ title: params.get('title'), text: params.get('text'), url: params.get('url') }, limit)
}
