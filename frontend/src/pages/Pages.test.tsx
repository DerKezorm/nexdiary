/** "Today" greets by the hour, in the person's name; the hour comes from outside, so no test hangs on the clock. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import '../i18n'
import { changeLanguage } from '../i18n'
import { greetingOf, TodayPage } from './Pages'

vi.mock('../state/auth', () => ({ useAuth: () => ({ me: { name: 'jule', display_name: 'Jule' } }) }))

describe('the greeting', () => {
  it('is the morning until eleven, the day until six, then the evening', () => {
    expect([0, 10, 11, 17, 18, 23].map(greetingOf)).toEqual(['morning', 'morning', 'day', 'day', 'evening', 'evening'])
  })

  it('names the day and the person', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await changeLanguage('de', false)
    const box = document.createElement('div')
    const root: Root = createRoot(box)
    await act(async () => root.render(<TodayPage now={new Date(2026, 9, 6, 19, 30)} />))
    expect(box.querySelector('p')!.textContent).toBe('Dienstag, 6. Oktober')
    expect(box.querySelector('h1')!.textContent).toBe('Guten Abend, Jule')
    act(() => root.unmount())
  })
})
