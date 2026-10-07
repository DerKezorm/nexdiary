/**
 * How many days others shared with me are new, for the mark at "Geteilt" in the menus. Asked when the page changes and
 * when the tab comes back into view; a page that opened a shared day asks again at once (`refresh`).
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

import { sharingApi } from '../api/client'

type Shared = { unseen: number; refresh: () => void }

const Context = createContext<Shared>({ unseen: 0, refresh: () => undefined })

export function SharedProvider({ children }: { children: ReactNode }) {
  const [unseen, setUnseen] = useState(0)
  const { pathname } = useLocation()
  const refresh = useCallback(() => {
    sharingApi.count().then(
      (answer) => setUnseen(answer.new),
      () => undefined,
    )
  }, [])
  useEffect(() => refresh(), [refresh, pathname])
  useEffect(() => {
    const again = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', again)
    return () => document.removeEventListener('visibilitychange', again)
  }, [refresh])
  return <Context.Provider value={{ unseen, refresh }}>{children}</Context.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useShared(): Shared {
  return useContext(Context)
}
