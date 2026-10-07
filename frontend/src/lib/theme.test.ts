/** Light, dark or as the system: a new browser without a choice follows the system; nexdiary is light by default. */
import { applyMode, applyPalette, isMode, isPalette, PALETTES, storedMode, storedPalette, storedTheme } from './theme'

function system(dark: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: dark && query.includes('dark'), addEventListener: () => undefined }))
}

describe('the mode', () => {
  beforeEach(() => {
    const kept = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute('data-theme')
  })

  it('follows the system while nothing was chosen', () => {
    system(true)
    expect(storedMode()).toBe('system')
    expect(storedTheme()).toBe('dark')
    system(false)
    expect(storedTheme()).toBe('light')
  })

  it('keeps a choice, and the system again when that is chosen', () => {
    system(true)
    applyMode('light')
    expect([storedMode(), storedTheme()]).toEqual(['light', 'light'])
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    applyMode('system')
    expect([storedMode(), storedTheme()]).toEqual(['system', 'dark'])
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('knows the three modes and nothing else', () => {
    expect(['system', 'light', 'dark'].every(isMode)).toBe(true)
    expect([undefined, '', 'sepia', true].some(isMode)).toBe(false)
  })
})

describe('the palette', () => {
  beforeEach(() => {
    const kept = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.removeAttribute('data-palette')
  })

  it('is sage until another is chosen, and a stored value that is none of the five counts as nothing', () => {
    expect(storedPalette()).toBe('salbei')
    localStorage.setItem('nexdiary.palette', 'neon')
    expect(storedPalette()).toBe('salbei')
  })

  it('paints and keeps a choice; sage needs no attribute', () => {
    applyPalette('tinte')
    expect([storedPalette(), document.documentElement.getAttribute('data-palette')]).toEqual(['tinte', 'tinte'])
    applyPalette('salbei')
    expect([storedPalette(), document.documentElement.hasAttribute('data-palette')]).toEqual(['salbei', false])
  })

  it('knows exactly the five colours of the server', () => {
    expect(PALETTES).toEqual(['salbei', 'terrakotta', 'pflaume', 'altrosa', 'tinte'])
    expect(['pflaume', 'neon', '', undefined, 3].map(isPalette)).toEqual([true, false, false, false, false])
  })
})
