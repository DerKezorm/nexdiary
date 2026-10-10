import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'

import { AppShell } from './components/AppShell'
import { CapsulesPage } from './pages/CapsulesPage'
import { AboutPage } from './pages/AboutPage'
import { AccountPage } from './pages/AccountPage'
import { ForgotPage, InvitePage, LoginPage, ResetPage, SetupPage } from './pages/AuthPages'
import { EntryPage } from './pages/EntryPage'
import { JournalPage } from './pages/JournalPage'
import { LibraryPage } from './pages/LibraryPage'
import { QuickPage } from './pages/QuickPage'
import { ReviewPage } from './pages/ReviewPage'
import { SettingsPage } from './pages/SettingsPage'
import { SharedEntryPage, SharedPage } from './pages/SharedPage'
import { StatsPage } from './pages/StatsPage'
import { TodayPage } from './pages/TodayPage'
import { waitingShare } from './lib/sharedInbox'
import { useAuth } from './state/auth'

/** The editor is the heaviest part of the app: loaded only when somebody writes. */
const WritePage = lazy(() => import('./pages/WritePage'))

/** Everything behind the sign-in: without an account the page goes to the sign-in, and comes back after. An account
 * that still has to set up its second factor (the operator requires one) reaches its own account page only. */
function SignedIn({ children }: { children: ReactNode }) {
  const { status, me } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  // Photos shared from another app while nobody was signed in wait in the browser. The way back after the sign-in
  // carries their address, but a sign-on through a provider comes back without it: once fully in, the app looks itself
  // and leads to the quick note, which takes them in.
  const ready = status === 'signedIn' && (!me?.session_stage || me.session_stage === 'full') && !me?.second_factor_setup_required
  const looked = useRef(false)
  useEffect(() => {
    if (!ready || looked.current) return
    looked.current = true
    if (location.pathname === '/schnell' && new URLSearchParams(location.search).has('geteilt')) return
    void waitingShare().then((id) => {
      if (id) navigate(`/schnell?geteilt=${id}`)
    })
  }, [ready, location, navigate])
  if (status === 'loading') return null
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedOut') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  // Right after the password, the sign-in page sets the second factor up before anything else opens.
  if (me?.session_stage && me.session_stage !== 'full') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  if (me?.second_factor_setup_required && location.pathname !== '/konto') return <Navigate to="/konto?tab=security" replace />
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="setup" element={<SetupPage />} />
      <Route path="login" element={<LoginPage />} />
      <Route path="invite/:token" element={<InvitePage />} />
      <Route path="forgot" element={<ForgotPage />} />
      <Route path="reset/:token" element={<ResetPage />} />
      {/* The quick note stands alone, without the menus of the app. */}
      <Route
        path="schnell"
        element={
          <SignedIn>
            <QuickPage />
          </SignedIn>
        }
      />
      <Route
        element={
          <SignedIn>
            <AppShell />
          </SignedIn>
        }
      >
        <Route index element={<TodayPage />} />
        <Route path="tagebuch" element={<JournalPage />} />
        <Route path="fotos" element={<LibraryPage />} />
        <Route path="statistik" element={<StatsPage />} />
        <Route path="rueckblick/:kind" element={<ReviewPage />} />
        <Route path="rueckblick/:kind/:start" element={<ReviewPage />} />
        <Route path="zeitkapseln" element={<CapsulesPage />} />
        <Route path="geteilt" element={<SharedPage />} />
        <Route path="geteilt/:from/:date" element={<SharedEntryPage />} />
        <Route path="tag/:date" element={<EntryPage />} />
        <Route path="konto" element={<AccountPage />} />
        <Route path="einstellungen" element={<SettingsPage />} />
        <Route path="ueber" element={<AboutPage />} />
        <Route
          path="tag/:date/schreiben"
          element={
            <Suspense fallback={null}>
              <WritePage />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
