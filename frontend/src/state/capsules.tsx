/**
 * How many time capsules for me have opened and are not read yet, for the mark at "Zeitkapseln" in the menus. Asked
 * when the page changes and when the tab comes back into view (a capsule opens at midnight); a page that read one asks
 * again at once (`refresh`).
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

import { capsulesApi } from '../api/client'

type Capsules = { opened: number; refresh: () => void }

const Context = createContext<Capsules>({ opened: 0, refresh: () => undefined })

export function CapsulesProvider({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState(0)
  const { pathname } = useLocation()
  const refresh = useCallback(() => {
    capsulesApi.count().then(
      (answer) => setOpened(answer.new),
      () => undefined,
    )
  }, [])
  useEffect(() => refresh(), [refresh, pathname])
  useEffect(() => {
    const again = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', again)
    return () => document.removeEventListener('visibilitychange', again)
  }, [refresh])
  return <Context.Provider value={{ opened, refresh }}>{children}</Context.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCapsules(): Capsules {
  return useContext(Context)
}
