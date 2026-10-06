/**
 * The pages before signing in, built as the mock's: the first account (with the setup code from the server's log),
 * signing in (password, then the second factor; or the provider's button), and accepting an invitation.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { ApiError, api, authApi, type Me, type Methods } from '../api/client'
import { Wordmark } from '../components/Logo'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import i18n from '../i18n'
import { errorText } from '../lib/errors'
import { safeNext, useAuth } from '../state/auth'
import { Input } from './settings/ui'

function AuthFrame({ title, text, children }: { title: string; text?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between px-5 py-4">
        <Wordmark size={32} />
        <ThemeSwitcher />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-10">
        <div className="card w-full max-w-sm p-7">
          <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
          {text && <p className="mt-1 text-sm text-ink-2">{text}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </div>
  )
}

function Primary({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <button type="submit" disabled={busy} className="h-11 w-full rounded-full bg-accent px-4 font-semibold text-accent-ink hover:brightness-105 disabled:opacity-50">
      {children}
    </button>
  )
}

function Problem({ code }: { code: string | null }) {
  if (!code) return null
  return (
    <p role="alert" className="rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
      {errorText(code)}
    </p>
  )
}

function Or() {
  const { t } = useTranslation()
  return (
    <div className="my-5 flex items-center gap-3 text-xs text-muted">
      <span className="h-px flex-1 bg-line" />
      {t('auth.or')}
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}

const OUTLINE = 'flex h-11 w-full items-center justify-center gap-2 rounded-full border border-line text-sm font-semibold hover:bg-sheet-2'

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : 'internal_error')

export function SetupPage() {
  const { t } = useTranslation()
  const { status, setMe } = useAuth()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  if (status === 'loading') return null
  if (status !== 'setup') return <Navigate to="/" replace />
  return (
    <AuthFrame title={t('auth.setup.title')} text={t('auth.setup.text')}>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault()
          if (!name.trim()) return setProblem('name_missing')
          setBusy(true)
          setProblem(null)
          try {
            setMe(await authApi.setup(name.trim(), password, code.trim(), i18n.language))
          } catch (error) {
            setProblem(codeOf(error))
          } finally {
            setBusy(false)
          }
        }}
      >
        <Problem code={problem} />
        <Input label={t('auth.setup.code')} value={code} onChange={setCode} autoFocus hint={t('auth.setup.codeHint')} />
        <Input label={t('auth.name')} value={name} onChange={setName} autoComplete="username" />
        <Input label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="new-password" hint={t('auth.passwordHint')} />
        <Primary busy={busy}>{t('auth.setup.submit')}</Primary>
      </form>
    </AuthFrame>
  )
}

export function LoginPage() {
  const { t } = useTranslation()
  const { status, setMe } = useAuth()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [methods, setMethods] = useState<Methods | null>(null)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [step, setStep] = useState<'password' | 'code'>('password')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(params.get('error'))
  const next = safeNext(params.get('next'))

  useEffect(() => {
    void authApi.methods().then(setMethods, () => setMethods({ password: true, oidc: false, oidc_name: '' }))
  }, [])

  if (status === 'loading') return null
  if (status === 'setup') return <Navigate to="/setup" replace />
  if (status === 'signedIn') return <Navigate to={next} replace />

  const submit = async () => {
    if (step === 'password' && !name.trim()) return setProblem('name_missing')
    if (step === 'password' && !password) return setProblem('password_missing')
    setBusy(true)
    setProblem(null)
    try {
      let answer: Me | { second_factor: true }
      if (step === 'code') answer = await authApi.code(code.trim())
      else answer = await authApi.login(name.trim(), password)
      if ('second_factor' in answer) {
        setPassword('')
        setCode('')
        setStep('code')
        return
      }
      setMe(await authApi.me())
      navigate(next, { replace: true })
    } catch (error) {
      const found = codeOf(error)
      setProblem(found)
      if (found === 'second_factor_expired') {
        setStep('password')
        setCode('')
      }
    } finally {
      setBusy(false)
    }
  }

  if (step === 'code') {
    return (
      <AuthFrame title={t('auth.code.title')} text={t('auth.code.text')}>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (code.trim()) void submit()
          }}
        >
          <Problem code={problem} />
          <Input label={t('auth.code.label')} value={code} onChange={setCode} autoComplete="one-time-code" autoFocus hint={t('auth.code.hint')} />
          <Primary busy={busy}>{t('auth.login.submit')}</Primary>
          <button
            type="button"
            className="w-full text-center text-xs text-muted hover:text-ink"
            onClick={() => {
              void authApi.cancelCode().catch(() => undefined)
              setStep('password')
              setCode('')
              setProblem(null)
            }}
          >
            {t('auth.code.back')}
          </button>
        </form>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame title={t('auth.login.title')} text={t('auth.login.text')}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Problem code={problem} />
        <Input label={t('auth.name')} value={name} onChange={setName} autoComplete="username" autoFocus />
        <Input label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" />
        <Primary busy={busy}>{t('auth.login.submit')}</Primary>
        {methods && !methods.password && <p className="text-xs text-muted">{t('auth.login.passwordOff')}</p>}
      </form>
      {methods?.oidc && (
        <>
          <Or />
          <a href={`/api/oidc/start?next=${encodeURIComponent(next)}`} className={OUTLINE}>
            {t('auth.login.oidc', { name: methods.oidc_name || 'OpenID Connect' })}
          </a>
        </>
      )}
    </AuthFrame>
  )
}

type InviteState = { min_password: number; signed_in_as: string | null }

export function InvitePage() {
  const { t } = useTranslation()
  const { token = '' } = useParams()
  const { setMe } = useAuth()
  const navigate = useNavigate()
  const [state, setState] = useState<InviteState | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [methods, setMethods] = useState<Methods | null>(null)

  useEffect(() => {
    api<InviteState>(`/api/invite/${encodeURIComponent(token)}`).then(setState, () => setInvalid(true))
    authApi.methods().then(setMethods, () => undefined)
  }, [token])

  if (invalid) {
    return (
      <AuthFrame title={t('auth.invite.invalidTitle')}>
        <p className="text-sm text-ink-2">{t('auth.invite.invalidText')}</p>
        <Link to="/login" className={OUTLINE + ' mt-5'}>
          {t('auth.backToLogin')}
        </Link>
      </AuthFrame>
    )
  }
  if (!state) return null

  if (state.signed_in_as) {
    // A link for a new account, opened by somebody signed in already: there is nothing to join.
    return (
      <AuthFrame title={t('auth.invite.title')} text={t('auth.invite.haveAccount', { name: state.signed_in_as })}>
        <Link to="/" className="flex h-11 w-full items-center justify-center rounded-full bg-accent px-4 font-semibold text-accent-ink hover:brightness-105">
          {t('auth.invite.toApp')}
        </Link>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame title={t('auth.invite.title')} text={t('auth.invite.text')}>
      {methods && !methods.password && !methods.oidc && <p className="text-sm text-ink-2">{t('auth.invite.noWay')}</p>}
      {(!methods || methods.password) && (
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault()
            if (!name.trim()) return setProblem('name_missing')
            setBusy(true)
            setProblem(null)
            try {
              setMe(await api<Me>(`/api/invite/${encodeURIComponent(token)}`, { method: 'POST', body: { name: name.trim(), password } }))
              navigate('/', { replace: true })
            } catch (error) {
              setProblem(codeOf(error))
            } finally {
              setBusy(false)
            }
          }}
        >
          <Problem code={problem} />
          <Input label={t('auth.name')} value={name} onChange={setName} autoComplete="username" autoFocus hint={t('auth.nameHint')} />
          <Input label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="new-password" hint={t('auth.passwordHint')} />
          <Primary busy={busy}>{t('auth.invite.submit')}</Primary>
        </form>
      )}
      {/* Through the sign-in provider: the invitation is the permission for the new account. */}
      {methods?.oidc && (
        <>
          {methods.password && <Or />}
          <a href={`/api/oidc/start?invite=${encodeURIComponent(token)}`} className={OUTLINE}>
            {t('auth.invite.withProvider', { name: methods.oidc_name || 'OpenID Connect' })}
          </a>
        </>
      )}
    </AuthFrame>
  )
}
