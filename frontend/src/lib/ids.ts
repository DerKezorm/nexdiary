/**
 * A random id for a note, made in the browser before it is sent: the same note sent twice (a double click, a retry
 * after a dropped connection) keeps one on the server. `crypto.randomUUID` exists only on https and localhost; nexdiary
 * runs on plain http in a home network too, so the UUID is built from `getRandomValues`, which exists everywhere.
 */
export function newId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
