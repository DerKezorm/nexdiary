// Before the first paint: light or dark from the last visit, so nothing flashes. Own file instead of an inline script,
// because the server's Content Security Policy only allows its own files.
try {
  var mode = localStorage.getItem('nexdiary.theme')
  var dark = mode === 'dark' || (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  if (dark) {
    document.documentElement.setAttribute('data-theme', 'dark')
    document.querySelector('meta[name="theme-color"]').content = '#1b1613'
  }
} catch (e) {
  /* private mode without localStorage */
}
