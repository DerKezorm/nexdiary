/** "1,2 GB", "340 MB": a size in bytes as a person reads it, with the separator of the language. A GB is 1024 MB, like
 * the limit the operator sets for a person. */
export function formatBytes(bytes: number, language: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  // One decimal from GB up ("1,2 GB"), none for a round number ("5 GB").
  const digits = unit >= 3 && value < 100 && !Number.isInteger(Math.round(value * 10) / 10) ? 1 : 0
  return `${new Intl.NumberFormat(language, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)} ${units[unit]}`
}
