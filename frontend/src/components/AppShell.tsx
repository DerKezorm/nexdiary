import { BarChart3, BookOpen, Heart, PenLine } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet } from 'react-router-dom'

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
export function AppShell() {
  const { t } = useTranslation()
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
              className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2.5 font-semibold transition ${isActive ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-sheet-2'}`}
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
          <AccountMenu />
        </div>
        <WhatsNewBanner />
        <Outlet />
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-sheet/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden" aria-label={t('app.mainMenu')}>
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[0.7rem] font-bold ${isActive ? 'text-accent' : 'text-muted'}`}>
            <Icon size={21} /> {t(label)}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
