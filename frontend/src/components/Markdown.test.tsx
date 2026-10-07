/** Should reading a page ever fail, the page shows its text as written, never nothing. */
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { Markdown } from './Markdown'

vi.mock('../lib/markdown', () => ({
  parseBlocks: () => {
    throw new RangeError('Maximum call stack size exceeded')
  },
}))

it('shows the text as written when reading it fails', () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const box = document.createElement('div')
  document.body.appendChild(box)
  const root = createRoot(box)
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  act(() => root.render(<Markdown text={'Erster **Absatz**\n\n<b>zweiter</b>'} />))
  quiet.mockRestore()
  expect([...box.querySelectorAll('.prose-diary > p')].map((p) => p.textContent)).toEqual(['Erster **Absatz**', '<b>zweiter</b>'])
  expect(box.querySelectorAll('b')).toHaveLength(0)
  act(() => root.unmount())
  box.remove()
})
