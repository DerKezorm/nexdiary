/**
 * What another app shared into nexdiary (the share target of the manifest): it arrives in the address as `title`,
 * `text` and `url`, each as the sharing app chose. One text for the quick note, nothing said twice: many apps put the
 * link into the text as well, some the title.
 */
export function sharedText(search: string, limit = 5000): string {
  const params = new URLSearchParams(search)
  const parts: string[] = []
  for (const key of ['title', 'text', 'url']) {
    const value = (params.get(key) ?? '').trim()
    if (value && !parts.some((part) => part.includes(value))) parts.push(value)
  }
  return parts.join('\n').slice(0, limit)
}
