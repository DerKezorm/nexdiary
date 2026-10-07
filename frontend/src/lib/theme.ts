/**
 * Light or dark, or as the system is set, and the accent colour. Both belong to the account (`profile.mode` and
 * `profile.palette`, kept on the server); this browser keeps a copy so that `public/theme.js` can paint the right ones
 * before the page has asked the server. It is only a preview: whatever the account says wins once it is known. The
 * colours behind it live solely in index.css; this only holds which mode and palette are active.
 */

export type Theme = 'dark' | 'light'
export type Mode = Theme | 'system'
export type Palette = 'salbei' | 'terrakotta' | 'pflaume' | 'altrosa' | 'tinte'

export const PALETTES: Palette[] = ['salbei', 'terrakotta', 'pflaume', 'altrosa', 'tinte']

const KEY = 'nexdiary.theme'
const PALETTE_KEY = 'nexdiary.palette'
const PAPER: Record<Theme, string> = { light: '#faf5ec', dark: '#1b1613' }

function systemTheme(): Theme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function isPalette(value: unknown): value is Palette {
  return typeof value === 'string' && (PALETTES as string[]).includes(value)
}

export function isMode(value: unknown): value is Mode {
  return value === 'system' || value === 'light' || value === 'dark'
}

/** The mode chosen in this browser; nothing chosen yet means the system's. */
export function storedMode(): Mode {
  try {
    const stored = localStorage.getItem(KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

/** The mode as it shows now: the system's when that was chosen. */
export function storedTheme(): Theme {
  const mode = storedMode()
  return mode === 'system' ? systemTheme() : mode
}

function paint(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'dark') root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme')
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', PAPER[theme])
}

export function applyMode(mode: Mode): void {
  paint(mode === 'system' ? systemTheme() : mode)
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    // Then the choice only holds until the next reload.
  }
}

/** While the mode is the system's, the page changes along when the system does. Once, at the start. */
export function followSystem(): void {
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (storedMode() === 'system') paint(systemTheme())
    })
  } catch {
    // An old browser: the mode stays as it was at the start.
  }
}

/** The accent colour chosen in this browser; sage until something else was chosen. */
export function storedPalette(): Palette {
  try {
    const stored = localStorage.getItem(PALETTE_KEY)
    return isPalette(stored) ? stored : 'salbei'
  } catch {
    return 'salbei'
  }
}

export function applyPalette(palette: Palette): void {
  const root = document.documentElement
  if (palette === 'salbei') root.removeAttribute('data-palette')
  else root.setAttribute('data-palette', palette)
  try {
    localStorage.setItem(PALETTE_KEY, palette)
  } catch {
    // Then the choice only holds until the next reload.
  }
}
