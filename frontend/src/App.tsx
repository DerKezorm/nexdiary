import type { ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'

import { AppShell } from './components/AppShell'
import { AboutPage } from './pages/AboutPage'
import { AccountPage } from './pages/AccountPage'
import { InvitePage, LoginPage, SetupPage } from './pages/AuthPages'
import { JournalPage, SharedPage, StatsPage, TodayPage } from './pages/Pages'
import { SettingsPage } from './pages/SettingsPage'
import { useAuth } from './state/auth'

/** Everything behind the sign-in: without an account the page goes to the sign-in, and comes back after. An account
 * that still has to set up its second factor (the operator requires one) reaches its own account page only. */
function SignedIn({ children }: { children: ReactNode }) {
  const { status, me } = useAuth()
  const location = useLocation()
  if (status === 'loading') return null
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedOut') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  if (me?.second_factor_setup_required && location.pathname !== '/konto') return <Navigate to="/konto?tab=security" replace />
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="setup" element={<SetupPage />} />
      <Route path="login" element={<LoginPage />} />
      <Route path="invite/:token" element={<InvitePage />} />
      <Route
        element={
          <SignedIn>
            <AppShell />
          </SignedIn>
        }
      >
        <Route index element={<TodayPage />} />
        <Route path="tagebuch" element={<JournalPage />} />
        <Route path="statistik" element={<StatsPage />} />
        <Route path="geteilt" element={<SharedPage />} />
        <Route path="konto" element={<AccountPage />} />
        <Route path="einstellungen" element={<SettingsPage />} />
        <Route path="ueber" element={<AboutPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
