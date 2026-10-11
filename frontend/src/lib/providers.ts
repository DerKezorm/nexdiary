/** The way to a sign-in provider (the shared sign-in module's start route, `vendor/nexoidc`). */

/** Where a provider's button leads: its start, with the invitation when one is accepted. */
export function startAddress(slug: string, { invite }: { invite?: string } = {}): string {
  const start = `/api/oidc/${encodeURIComponent(slug)}/start`
  return invite ? `${start}?invite=${encodeURIComponent(invite)}` : start
}

/** Off to the provider (a full page load: the way back comes to the server, not to this page). */
export function go(url: string): void {
  window.location.assign(url)
}
