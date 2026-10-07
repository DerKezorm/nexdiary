import { BarChart3, BookOpen, Heart, PenLine, SquarePen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom'

import { useAuth } from '../state/auth'

import { AccountMenu } from './AccountMenu'
import { Wordmark } from './Logo'
import { WhatsNewBanner } from './WhatsNew'

const NAV = [
  { to: '/', label: 'nav.today', icon: PenLine },
  { to: '/tagebuch', label: 'nav.journal', icon: BookOpen },
  { to: '/statistik', label: 'nav.stats', icon: BarChart3 },
  { to: '/geteilt', label: 'nav.shared', icon: Heart },
]

/** The frame of the mock: a sidebar on a large screen, a header and a bar at the bottom on a phone. */
/** Below this width nexdiary counts as on a phone (the breakpoint of the mock, `md`). */
const PHONE_WIDTH = 768
const QUICK_SHOWN = 'nexdiary.quickShown'

/**
 * On a phone nexdiary opens on the quick note, once per visit (as the mock): "Alles" from there stays in the whole app.
 * Off when the person switched it off under Settings, Look.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function shouldOpenQuick(pathname: string, quickStart: boolean, width: number, shownBefore: boolean): boolean {
  return pathname === '/' && quickStart && width < PHONE_WIDTH && !shownBefore
}

function useQuickStart() {
  const { me } = useAuth()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const quickStart = me?.profile?.quick_start ?? false
  useEffect(() => {
    let shown = false
    try {
      shown = sessionStorage.getItem(QUICK_SHOWN) === '1'
    } catch {
      // Private mode: then every time.
    }
    if (!shouldOpenQuick(pathname, quickStart, window.innerWidth, shown)) return
    try {
      sessionStorage.setItem(QUICK_SHOWN, '1')
    } catch {
      // As above.
    }
    navigate('/schnell', { replace: true })
  }, [pathname, quickStart, navigate])
}

/** A short sentence after something was done ("Gespeichert."), handed over by the page that did it as `notice` in the
 * navigation state; shown for a moment, then gone, and not again after a reload. */
function Toast() {
  const location = useLocation()
  const navigate = useNavigate()
  const [shown, setShown] = useState<string | null>(null)
  const notice = (location.state as { notice?: unknown } | null)?.notice
  useEffect(() => {
    if (typeof notice !== 'string') return
    setShown(notice)
    navigate(location.pathname + location.search, { replace: true, state: null })
  }, [notice, navigate, location.pathname, location.search])
  useEffect(() => {
    if (!shown) return
    const timer = window.setTimeout(() => setShown(null), 3500)
    return () => window.clearTimeout(timer)
  }, [shown])
  if (!shown) return null
  return (
    <div role="status" className="rise fixed inset-x-0 bottom-24 z-40 flex justify-center px-4 lg:bottom-8">
      <p className="rounded-full bg-ink px-4 py-2.5 text-sm font-semibold text-paper shadow-soft">{shown}</p>
    </div>
  )
}

export function AppShell() {
  const { t } = useTranslation()
  useQuickStart()
  // While writing, the page is the writing: "Save" takes the place of the menu bar on a phone.
  const writing = useMatch('/tag/:date/schreiben') !== null
  return (
    <div className="lg:flex">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line px-4 py-6 lg:flex">
        <div className="px-2 pb-8">
          <Wordmark />
        </div>
        <nav className="space-y-1" aria-label={t('app.mainMenu')}>
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              // Writing a day up belongs to "Today", as in the mock.
              className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2.5 font-semibold transition ${isActive || (writing && to === '/') ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-sheet-2'}`}
            >
              <Icon size={19} /> {t(label)}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto">
          <AccountMenu up />
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="flex items-center justify-between px-4 pt-4 lg:hidden">
          <Wordmark size={30} />
          <div className="flex items-center gap-2">
            <Link to="/schnell" className="rounded-full bg-accent p-2 text-accent-ink" aria-label={t('quick.open')}>
              <SquarePen size={18} aria-hidden />
            </Link>
            <AccountMenu />
          </div>
        </div>
        <WhatsNewBanner />
        <Outlet />
      </main>

      <Toast />
      <nav hidden={writing} className={`fixed inset-x-0 bottom-0 z-30 border-t border-line bg-sheet/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden ${writing ? 'hidden' : 'flex'}`} aria-label={t('app.mainMenu')}>
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[0.7rem] font-bold ${isActive ? 'text-accent' : 'text-muted'}`}>
            <Icon size={21} /> {t(label)}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
