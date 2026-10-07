/**
 * The own account in tabs, as the mock (and nexlore): Profile (picture, display name, name, role, mail address),
 * Security (password, second factor, the link to the provider), AI (the own switch, and what the operator set up)
 * and Connections (API tokens for programs). The tab stands in the address (`?tab=`). Reminders come with their block.
 */
import { Camera, KeyRound, Plug, ShieldCheck, Sparkles, Trash2, User } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { api, authApi, type Me, type Methods } from '../api/client'
import { ApiTokens } from '../components/ApiTokens'
import { Avatar } from '../components/Avatar'
import { copyText } from '../lib/copy'
import { providerName } from '../lib/aiProviders'
import { useAiState } from '../state/ai'
import { useAuth } from '../state/auth'
import { Button, Card, Feedback, Input, saveAsFile, TabRow, Toggle, useAction, type Tab } from './settings/ui'

type Part = 'profile' | 'security' | 'ai' | 'connections'
const PARTS: Part[] = ['profile', 'security', 'ai', 'connections']

export function AccountPage() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [params, setParams] = useSearchParams()
  const asked = params.get('tab') as Part | null
  // Back from the provider (linking the account): its answer stands on the security tab.
  const part: Part = asked && PARTS.includes(asked) ? asked : params.get('linked') || params.get('error') ? 'security' : 'profile'
  if (!me) return null
  const tabs: Tab<Part>[] = [
    { value: 'profile', label: t('me.tabs.profile'), icon: User },
    { value: 'security', label: t('me.tabs.security'), icon: ShieldCheck },
    { value: 'ai', label: t('me.tabs.ai'), icon: Sparkles },
    { value: 'connections', label: t('me.tabs.connections'), icon: Plug },
  ]
  return (
    <div className="page space-y-5 pt-8 pb-28 lg:pb-12">
      <h1 className="font-display text-3xl font-semibold tracking-tight">{t('me.title')}</h1>
      <TabRow tabs={tabs} active={part} label={t('me.title')} onChange={(value) => setParams(value === 'profile' ? {} : { tab: value }, { replace: true })} />
      <div className="space-y-6 pt-1">
        {part === 'profile' && <Profile me={me} />}
        {part === 'security' && <Security me={me} />}
        {part === 'ai' && <AiPart me={me} />}
        {part === 'connections' && <ApiTokens />}
      </div>
    </div>
  )
}

/** "KI beim Schreiben", as the mock: the own switch, and below it what the operator set up for everybody. */
function AiPart({ me }: { me: Me }) {
  const { t } = useTranslation()
  const { setMe } = useAuth()
  const ai = useAiState()
  const action = useAction()
  const mine = me.profile.ai !== false
  const provider = ai?.provider ?? 'none'
  return (
    <Card icon={Sparkles} title={t('me.ai.title')} text={t('me.ai.text')}>
      <Toggle
        label={t('me.ai.mine')}
        hint={t('me.ai.mineHint')}
        checked={mine}
        onChange={(value) => {
          setMe({ ...me, profile: { ...me.profile, ai: value } })
          void action.run(async () => setMe({ ...me, profile: await authApi.preferences({ ai: value }) })).then(
            (worked) => worked || setMe(me),
          )
        }}
      />
      {ai && (
        <div className="mt-4 rounded-xl bg-sheet-2 px-4 py-3 text-sm">
          <p>
            <span className="font-semibold">{t('me.ai.byOperator')}</span> {providerName(provider, t)}
            {provider === 'local' && ai.model && ` (${ai.model})`}
          </p>
          <p className="mt-1 text-ink-2">{t(`server.ai.${provider}Note`)}</p>
        </div>
      )}
      <Feedback problem={action.problem} />
    </Card>
  )
}

function Profile({ me }: { me: Me }) {
  const { t } = useTranslation()
  const { setMe } = useAuth()
  const [shownAs, setShownAs] = useState(me.display_name)
  const picker = useRef<HTMLInputElement>(null)
  const action = useAction()
  return (
    <Card icon={User} title={t('me.tabs.profile')} text={t('me.profile.text')}>
      <div className="flex flex-wrap items-center gap-5">
        <Avatar person={me} size={72} />
        <div className="flex flex-wrap gap-2">
          <Button busy={action.busy} onClick={() => picker.current?.click()}>
            <Camera size={16} /> {me.avatar ? t('me.profile.change') : t('me.profile.upload')}
          </Button>
          {me.avatar && (
            <Button busy={action.busy} onClick={() => void action.run(async () => setMe(await api<Me>('/api/auth/avatar', { method: 'DELETE' })), t('me.profile.removed'))}>
              <Trash2 size={16} /> {t('me.profile.remove')}
            </Button>
          )}
        </div>
        <input
          ref={picker}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/bmp,image/heic,image/heif,image/avif,.heic,.heif"
          aria-label={t('me.profile.upload')}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void action.run(async () => setMe(await api<Me>('/api/auth/avatar', { method: 'PUT', raw: file })), t('me.profile.saved'))
          }}
        />
      </div>
      <p className="-mt-1 text-xs text-muted">{t('me.profile.hint')}</p>
      <form
        className="flex flex-wrap items-start gap-2 pt-2"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(async () => {
            const saved = await authApi.profile(shownAs.trim())
            setShownAs(saved.display_name)
            setMe(saved)
          }, t('me.profile.displaySaved'))
        }}
      >
        <Input
          label={t('me.profile.displayName')}
          value={shownAs}
          onChange={setShownAs}
          autoComplete="name"
          className="min-w-60 flex-1"
          hint={t(me.sign_in === 'password' ? 'me.profile.displayHintPassword' : 'me.profile.displayHint', { name: me.name })}
        />
        <Button type="submit" busy={action.busy} disabled={shownAs.trim() === me.display_name} className="mt-6">
          {t('common.save')}
        </Button>
      </form>
      <dl className="grid grid-cols-[8rem_1fr] gap-y-2 pt-2 text-sm" data-testid="account-facts">
        <dt className="text-muted">{t('me.profile.name')}</dt>
        <dd className="font-semibold">{me.name}</dd>
        <dt className="text-muted">{t('me.profile.role')}</dt>
        <dd className="font-semibold">{t(`me.role.${me.role}`)}</dd>
        {me.email && (
          <>
            <dt className="text-muted">{t('me.profile.email')}</dt>
            <dd className="font-semibold">{me.email}</dd>
          </>
        )}
      </dl>
      <Feedback problem={action.problem} done={action.done} values={action.values} />
    </Card>
  )
}

function Security({ me }: { me: Me }) {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const [params] = useSearchParams()
  const [methods, setMethods] = useState<Methods | null>(null)
  const [pw, setPw] = useState({ current: '', next: '', again: '', link: '' })
  const password = useAction()
  const [unsent, setUnsent] = useState<string | null>(null)
  const link = useAction()
  const [linkDone] = useState(params.get('linked') ? t('me.oidc.linkedNow') : null)
  const [linkProblem] = useState(params.get('error'))
  useEffect(() => {
    authApi.methods().then(setMethods, () => setMethods(null))
  }, [])
  const provider = methods?.oidc_name || 'OpenID Connect'
  return (
    <>
      {me.second_factor_setup_required && (
        <p role="note" className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm font-semibold text-warn">
          {t('me.setupFirst')}
        </p>
      )}
      {me.sign_in === 'password' && (
        <Card icon={KeyRound} title={t('me.password.title')} text={t('me.password.text')}>
          <form
            className="grid gap-3 sm:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault()
              // Said here, before anything goes to the server.
              const missing = !pw.current ? 'current_password_missing' : !pw.next ? 'password_missing' : pw.next !== pw.again ? 'password_mismatch' : null
              setUnsent(missing)
              if (missing) return
              void password.run(async () => {
                await authApi.password(pw.current, pw.next)
                setPw({ ...pw, current: '', next: '', again: '' })
              }, t('me.password.done'))
            }}
          >
            <Input label={t('me.password.current')} type="password" value={pw.current} onChange={(current) => setPw({ ...pw, current })} autoComplete="current-password" />
            <Input label={t('me.password.new')} type="password" value={pw.next} onChange={(next) => setPw({ ...pw, next })} autoComplete="new-password" />
            <Input label={t('me.password.again')} type="password" value={pw.again} onChange={(again) => setPw({ ...pw, again })} autoComplete="new-password" />
            <div className="sm:col-span-3">
              <Button type="submit" busy={password.busy}>
                {t('me.password.submit')}
              </Button>
            </div>
          </form>
          <Feedback problem={unsent ?? password.problem} done={password.done} />
        </Card>
      )}

      <Card icon={ShieldCheck} title={t('twofactor.title')} text={t('twofactor.lead')}>
        <SecondFactor me={me} />
      </Card>

      {(methods?.oidc || me.sign_in === 'oidc' || me.oidc_linked) && (
        <Card icon={ShieldCheck} title={t('me.oidc.title')} text={t('me.oidc.text', { name: provider })}>
          {me.sign_in === 'oidc' ? (
            <p className="text-sm text-ink-2">{t('me.oidc.only', { name: provider })}</p>
          ) : me.oidc_linked ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-ink-2">{t('me.oidc.linked', { name: provider })}</span>
              <Button
                busy={link.busy}
                onClick={() =>
                  void link.run(async () => {
                    await api('/api/oidc/link', { method: 'DELETE' })
                    await refresh()
                  }, t('me.oidc.unlinked'))
                }
              >
                {t('me.oidc.unlink')}
              </Button>
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                void link.run(async () => {
                  const { url } = await api<{ url: string }>('/api/oidc/link/start', { method: 'POST', body: { password: pw.link } })
                  window.location.assign(url)
                })
              }}
            >
              <p className="text-sm text-ink-2">{t('me.oidc.how', { name: provider })}</p>
              <Input label={t('auth.password')} type="password" value={pw.link} onChange={(value) => setPw({ ...pw, link: value })} autoComplete="current-password" className="max-w-sm" />
              <Button type="submit" busy={link.busy}>
                {t('me.oidc.link', { name: provider })}
              </Button>
            </form>
          )}
          <Feedback problem={link.problem ?? linkProblem} done={link.done ?? linkDone} />
        </Card>
      )}
    </>
  )
}

/** Below this many recovery codes the account is told to make new ones. */
const LOW_CODES = 3

type Enrolment = { secret: string; uri: string; qr_svg: string }

/**
 * The second factor of the own account: set up (scan the code, type one code and the password), new recovery codes,
 * turn off. Recovery codes are shown once, right after they were made, to copy or save as a file.
 */
function SecondFactor({ me }: { me: Me }) {
  const { t } = useTranslation()
  const { refresh } = useAuth()
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null)
  const [asking, setAsking] = useState<'disable' | 'renew' | null>(null)
  const [digits, setDigits] = useState('')
  const [password, setPassword] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [copied, setCopied] = useState(false)
  const action = useAction()

  if (me.sign_in !== 'password') return <p className="text-sm text-ink-2">{t('twofactor.provider')}</p>

  const close = () => {
    setEnrolment(null)
    setAsking(null)
    setDigits('')
    setPassword('')
    action.clear()
  }
  const codesText = (codes ?? []).join('\n')

  if (codes)
    return (
      <div className="space-y-3" data-testid="recovery-codes">
        <p className="text-sm text-ink-2">{t('twofactor.codesLead')}</p>
        <ol className="grid grid-cols-2 gap-2 rounded-xl bg-sheet-2 p-4 font-mono text-sm sm:grid-cols-4">
          {codes.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void copyText(codesText).then(setCopied)}>{copied ? t('common.copied') : t('common.copy')}</Button>
          <Button onClick={() => saveAsFile(`nexdiary-recovery-codes-${me.name}.txt`, new Blob([codesText + '\n'], { type: 'text/plain' }))}>{t('twofactor.codesDownload')}</Button>
          <Button
            primary
            onClick={() => {
              setCodes(null)
              setCopied(false)
              void refresh()
            }}
          >
            {t('twofactor.codesDone')}
          </Button>
        </div>
      </div>
    )

  if (enrolment)
    return (
      <div className="grid gap-5 sm:grid-cols-[10rem_1fr]">
        <img src={'data:image/svg+xml;utf8,' + encodeURIComponent(enrolment.qr_svg)} alt={t('twofactor.qr')} className="h-40 w-40 rounded-xl bg-white p-1" />
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void action.run(async () => {
              const result = await api<{ recovery_codes: string[] }>('/api/auth/totp/confirm', { method: 'POST', body: { code: digits.trim(), password } })
              close()
              setCodes(result.recovery_codes)
            })
          }}
        >
          <p className="text-sm text-ink-2">{t('twofactor.scan')}</p>
          <p className="font-mono text-xs break-all text-muted" data-testid="totp-secret">
            {enrolment.secret.replace(/(.{4})/g, '$1 ').trim()}
          </p>
          <Input label={t('twofactor.code')} value={digits} onChange={setDigits} autoComplete="one-time-code" autoFocus />
          <Input label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" hint={t('twofactor.passwordHint')} />
          <Feedback problem={action.problem} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" primary busy={action.busy} disabled={digits.trim().length !== 6 || !password}>
              {t('twofactor.confirm')}
            </Button>
            <Button onClick={close}>{t('common.cancel')}</Button>
          </div>
        </form>
      </div>
    )

  if (asking)
    return (
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(async () => {
            if (asking === 'disable') {
              await api('/api/auth/totp/disable', { method: 'POST', body: { password } })
              close()
              await refresh()
            } else {
              const result = await api<{ recovery_codes: string[] }>('/api/auth/totp/recovery', { method: 'POST', body: { password } })
              close()
              setCodes(result.recovery_codes)
            }
          })
        }}
      >
        <p className="text-sm text-ink-2">{asking === 'disable' ? t('twofactor.disableText') : t('twofactor.renewText')}</p>
        <Input label={t('auth.password')} value={password} onChange={setPassword} type="password" autoComplete="current-password" autoFocus className="max-w-sm" />
        <Feedback problem={action.problem} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={action.busy} disabled={!password} primary={asking === 'renew'} danger={asking === 'disable'}>
            {asking === 'disable' ? t('twofactor.disable') : t('twofactor.renew')}
          </Button>
          <Button onClick={close}>{t('common.cancel')}</Button>
        </div>
      </form>
    )

  return (
    <div className="space-y-3">
      {me.two_factor ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-ink-2">{t('twofactor.on', { count: me.two_factor_recovery_left })}</span>
          <Button onClick={() => setAsking('renew')}>{t('twofactor.renew')}</Button>
          <Button danger onClick={() => setAsking('disable')}>
            {t('twofactor.disable')}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3 text-sm">
          <span className="text-ink-2">{t('twofactor.off')}</span>
          <Button primary busy={action.busy} onClick={() => void action.run(async () => setEnrolment(await api<Enrolment>('/api/auth/totp/begin', { method: 'POST' })))}>
            {t('twofactor.enable')}
          </Button>
        </div>
      )}
      {me.two_factor && me.two_factor_recovery_left < LOW_CODES && (
        <p role="note" className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          {t('twofactor.lowCodes')}
        </p>
      )}
      <Feedback problem={action.problem} />
    </div>
  )
}
