/**
 * The operator's part of the settings, as the mock (and nexlore): accounts and invitations, sign-in (password, second
 * factor, public address, OIDC and authentik), mail, API tokens, backups, languages and the log. Everything here is the
 * server's; it applies to all. The operator manages accounts and never sees what is written in them.
 */
import { Database, Download, HardDrive, Languages, Mail, MoreHorizontal, Plug, Plus, RotateCcw, ScrollText, Shield, ShieldCheck, Trash2, Upload, Users } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, apiTokensApi, passwordHeader, type AnyApiToken, type Me } from '../../api/client'
import { Avatar } from '../../components/Avatar'
import { Dialog } from '../../components/Dialog'
import { byName, forgetAddedLanguages, templateFile } from '../../i18n'
import { useAuth } from '../../state/auth'
import { Button, Card, Confirm, CopyLink, Feedback, Input, saveAsFile, Select, SubHead, Toggle, useAction } from './ui'

export type ServerSettings = {
  public_url: string
  password_login: boolean
  two_factor_required: boolean
  oidc_second_factor_by_provider: boolean
  master_key_saved_at: string | null
  backup_schedule: 'off' | 'daily' | 'weekly'
  backup_keep: number
  smtp_host: string
  smtp_port: number
  smtp_security: 'starttls' | 'tls' | 'none'
  smtp_user: string
  smtp_password_set: boolean
  smtp_from: string
  api_tokens_allowed: boolean
  update_check: boolean
  storage_per_person_gb: number
}

type Change = Partial<ServerSettings> & { smtp_password?: string; current_password?: string }
type Server = ReturnType<typeof useServerSettings>

// eslint-disable-next-line react-refresh/only-export-components
export function useServerSettings() {
  const [settings, setSettings] = useState<ServerSettings | null>(null)
  const action = useAction()
  useEffect(() => {
    api<ServerSettings>('/api/settings').then(setSettings, () => undefined)
  }, [])
  /** The switch moves at once; the server's answer confirms it, a refusal puts it back. */
  const save = async (change: Change, done?: string) => {
    const before = settings
    if (settings) setSettings({ ...settings, ...change })
    const ok = await action.run(async () => setSettings(await api<ServerSettings>('/api/settings', { method: 'PUT', body: change })), done)
    if (!ok) setSettings(before)
  }
  return { settings, save, setSettings, ...action }
}

type AccountRow = Me & { locked: boolean; blocked?: boolean; has_password?: boolean; created_at: string; last_seen_at: string | null }
type OpenInvite = { id: number; email: string; expires_at: string }
type Asking = 'role' | 'delete' | 'link' | 'reset' | 'signout' | 'block' | 'unblock'
/** What came of sending a link to set a new password: by mail, or to pass on once. */
type LinkMade = { name: string; sent: boolean; email?: string; link?: string }
const DAYS = ['1', '7', '30'] as const

/** Every account, and the invitations that bring new ones. */
export function AccountsCard() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const [list, setList] = useState<AccountRow[]>([])
  const [inviting, setInviting] = useState(false)
  const [invites, setInvites] = useState<OpenInvite[]>([])
  const [menu, setMenu] = useState<number | null>(null)
  const [asking, setAsking] = useState<{ kind: Asking; account: AccountRow } | null>(null)
  const [made, setMade] = useState<LinkMade | null>(null)
  const { busy, problem, done, run } = useAction()
  const load = useCallback(() => {
    api<AccountRow[]>('/api/accounts').then(setList, () => undefined)
    api<OpenInvite[]>('/api/invites').then(setInvites, () => undefined)
  }, [])
  useEffect(load, [load])
  useEffect(() => {
    if (menu === null) return
    const away = (event: MouseEvent) => {
      if (!(event.target as Element).closest('[data-account-actions]')) setMenu(null)
    }
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setMenu(null)
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [menu])

  const actions = (row: AccountRow): { kind: Asking; label: string }[] => [
    { kind: 'role', label: row.role === 'operator' ? t('server.makeMember') : t('server.makeOperator') },
    ...(row.two_factor ? [{ kind: 'reset' as const, label: t('server.resetTwoFactor') }] : []),
    { kind: 'signout', label: t('server.signOutEverywhere') },
    row.blocked ? { kind: 'unblock' as const, label: t('server.unblock') } : { kind: 'block' as const, label: t('server.block') },
    { kind: 'delete', label: t('server.deleteAccount') },
  ]

  return (
    <Card id="accounts" icon={Users} title={t('server.accounts')} text={t('server.accountsHint')}>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {list.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <Avatar person={row} size={34} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">
                {row.display_name || row.name}
                {row.display_name && <span className="ml-1 text-xs font-normal text-muted">{row.name}</span>}
              </span>
              <span className="block text-xs text-muted">
                {t(`me.role.${row.role}`)} · {t(`server.signInBy.${row.sign_in}`)}
                {row.two_factor ? ' · ' + t('server.withTwoFactor') : ''}
                {row.locked ? ' · ' + t('server.locked') : ''}
                {row.blocked ? ' · ' + t('server.blocked') : ''}
              </span>
            </span>
            {row.id !== me?.id && (
              <span className="relative flex items-center gap-1.5" data-account-actions>
                <Button small onClick={() => setAsking({ kind: 'link', account: row })}>
                  {row.has_password === false ? t('server.givePassword') : t('server.newPassword')}
                </Button>
                <button
                  type="button"
                  aria-expanded={menu === row.id}
                  aria-haspopup="true"
                  aria-label={t('server.more', { name: row.name })}
                  onClick={() => setMenu(menu === row.id ? null : row.id)}
                  className="rounded-full p-1.5 text-muted hover:bg-sheet-2 hover:text-ink"
                >
                  <MoreHorizontal size={18} />
                </button>
                {menu === row.id && (
                  <span className="card rise absolute top-full right-0 z-40 mt-1 block w-60 p-1.5">
                    {actions(row).map((entry) => (
                      <button
                        key={entry.kind}
                        type="button"
                        onClick={() => {
                          setMenu(null)
                          setAsking({ kind: entry.kind, account: row })
                        }}
                        className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-semibold hover:bg-sheet-2 ${entry.kind === 'delete' || entry.kind === 'block' ? 'text-bad' : 'text-ink-2'}`}
                      >
                        {entry.label}
                      </button>
                    ))}
                  </span>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      {invites.length > 0 && (
        <ul className="space-y-2" data-testid="open-invites">
          {invites.map((invite) => (
            <li key={invite.id} className="flex items-center gap-3 rounded-xl border border-line bg-sheet-2/50 px-4 py-2.5 text-sm">
              <span className="flex-1">
                <span className="font-semibold">{invite.email || t('invite.noEmail')}</span>
                <span className="block text-xs text-muted">{t('invite.until', { when: new Date(invite.expires_at).toLocaleDateString(i18n.language) })}</span>
              </span>
              <Button
                small
                busy={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/api/invites/${invite.id}`, { method: 'DELETE' })
                    load()
                  })
                }
              >
                {t('invite.withdraw')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button primary onClick={() => setInviting(true)}>
          <Plus size={16} /> {t('server.invite')}
        </Button>
      </div>
      {made && (
        <div className="space-y-2 text-sm text-ink-2" role="status">
          {made.sent ? (
            <p>{t('server.linkSent', { name: made.name, email: made.email })}</p>
          ) : (
            <>
              <p>{t('server.linkShown', { name: made.name })}</p>
              {made.link && <CopyLink value={made.link} label={t('server.linkLabel')} />}
            </>
          )}
        </div>
      )}
      <Feedback problem={problem} done={done} />
      {inviting && (
        <InviteDialog
          onClose={() => {
            setInviting(false)
            load()
          }}
        />
      )}
      {asking && (
        <Confirm
          title={t(`server.confirm.${asking.kind}.title`, { name: asking.account.name })}
          text={t(asking.kind === 'role' ? (asking.account.role === 'operator' ? 'server.confirm.demote.text' : 'server.confirm.promote.text') : `server.confirm.${asking.kind}.text`, { name: asking.account.name })}
          confirm={t(`server.confirm.${asking.kind}.button`)}
          danger={asking.kind === 'delete' || asking.kind === 'block'}
          password={me?.sign_in === 'password' && asking.kind !== 'signout'}
          onCancel={() => setAsking(null)}
          onConfirm={async (password) => {
            const id = asking.account.id
            if (asking.kind === 'role') await api(`/api/accounts/${id}/role`, { method: 'PUT', body: { role: asking.account.role === 'operator' ? 'member' : 'operator', current_password: password } })
            if (asking.kind === 'delete') await api(`/api/accounts/${id}`, { method: 'DELETE', body: { current_password: password } })
            if (asking.kind === 'reset') await api(`/api/accounts/${id}/totp/reset`, { method: 'POST', body: { current_password: password } })
            if (asking.kind === 'signout') await api(`/api/accounts/${id}/sign-out`, { method: 'POST' })
            if (asking.kind === 'unblock') await api(`/api/accounts/${id}/unblock`, { method: 'POST', body: { current_password: password } })
            if (asking.kind === 'block') await api(`/api/accounts/${id}/block`, { method: 'POST', body: { current_password: password } })
            if (asking.kind === 'link') {
              // The operator sets no password: the person does, through a link that goes by mail or is shown here once.
              const sent = await api<{ sent: boolean; email?: string; link?: string }>(`/api/accounts/${id}/reset-link`, { method: 'POST', body: { current_password: password } })
              setMade({ name: asking.account.name, ...sent })
            }
            setAsking(null)
            load()
          }}
        />
      )}
    </Card>
  )
}

/** "Invite somebody": how long the link holds, to which address it may go, and the link itself, shown once. */
function InviteDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [days, setDays] = useState<(typeof DAYS)[number]>('7')
  const [email, setEmail] = useState('')
  const [send, setSend] = useState(true)
  const [made, setMade] = useState<{ link: string; sent: boolean; email: string } | null>(null)
  const { busy, problem, run } = useAction()
  return (
    <Dialog title={t('server.invite')} onClose={onClose}>
      {made ? (
        <div className="space-y-3">
          <CopyLink value={made.link} label={t('invite.copy')} />
          <p className="text-sm text-ink-2">{made.sent ? t('invite.sent', { email: made.email }) : t('invite.once')}</p>
          <div className="flex justify-end">
            <Button primary onClick={onClose}>
              {t('common.done')}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => setMade(await api<{ link: string; sent: boolean; email: string }>('/api/invites', { method: 'POST', body: { days: Number(days), email: email.trim(), send: send && !!email.trim() } })))
          }}
        >
          <p className="text-sm text-ink-2">{t('server.inviteText')}</p>
          <Select label={t('invite.valid')} value={days} options={DAYS.map((value) => ({ value, label: t('invite.days', { count: Number(value) }) }))} onChange={setDays} />
          <Input label={t('invite.email')} value={email} onChange={setEmail} type="email" hint={me?.mail ? undefined : t('invite.noMail')} />
          {me?.mail && email.trim() && <Toggle label={t('invite.send')} checked={send} onChange={setSend} />}
          <Feedback problem={problem} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" primary busy={busy}>
              {t('invite.create')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}

type Oidc = { configured: boolean; issuer: string; client_id: string; provider_name: string; auto_create: boolean; redirect_uri: string }
type Steps = { steps: { key: string; ok: boolean; detail: string }[] }

export function SignInCard({ server }: { server: Server }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [oidc, setOidc] = useState<Oidc | null>(null)
  const [form, setForm] = useState({ issuer: '', client_id: '', client_secret: '', provider_name: '', auto_create: false })
  const [address, setAddress] = useState<string | null>(null)
  const [authentik, setAuthentik] = useState({ url: '', token: '' })
  const [steps, setSteps] = useState<Steps | null>(null)
  // Switches that make signing in weaker ask for the operator's password first.
  const [weaker, setWeaker] = useState<'two_factor_off' | 'provider_checks' | null>(null)
  const { busy, problem, done, run } = useAction()

  const loadOidc = useCallback(async () => {
    const config = await api<Oidc>('/api/oidc/config')
    setOidc(config)
    setForm({ issuer: config.issuer, client_id: config.client_id, client_secret: '', provider_name: config.provider_name, auto_create: config.auto_create })
  }, [])
  useEffect(() => {
    void run(loadOidc)
  }, [run, loadOidc])

  const s = server.settings
  if (!s) return null
  const ownFirst = !s.two_factor_required && !me?.two_factor
  const provider = oidc?.provider_name || 'OpenID Connect'
  return (
    <Card id="sign-in" icon={Shield} title={t('server.signin')} text={t('server.signinText')}>
      <Toggle label={t('server.passwordLogin')} hint={t('server.passwordLoginHint')} checked={s.password_login} onChange={(password_login) => void server.save({ password_login })} />
      {/* Without an own second factor the operator would be the first one sent away: first the own one. */}
      <Toggle
        label={t('server.twoFactorRequired')}
        hint={ownFirst ? t('server.ownSecondFactorFirst') : t('server.twoFactorRequiredHint')}
        checked={s.two_factor_required}
        disabled={ownFirst}
        onChange={(on) => (on ? void server.save({ two_factor_required: true }) : setWeaker('two_factor_off'))}
      />
      {oidc?.configured && (
        <Toggle
          label={t('server.providerChecks', { name: provider })}
          hint={t('server.providerChecksHint', { name: provider })}
          checked={s.oidc_second_factor_by_provider}
          onChange={(on) => (on ? setWeaker('provider_checks') : void server.save({ oidc_second_factor_by_provider: false }))}
        />
      )}
      {weaker && (
        <Confirm
          title={t(`server.confirm.${weaker}.title`)}
          text={t(`server.confirm.${weaker}.text`, { name: provider })}
          confirm={t(`server.confirm.${weaker}.button`)}
          danger
          password={me?.sign_in === 'password'}
          onCancel={() => setWeaker(null)}
          onConfirm={async (current_password) => {
            const change: Change = weaker === 'two_factor_off' ? { two_factor_required: false } : { oidc_second_factor_by_provider: true }
            server.setSettings(await api<ServerSettings>('/api/settings', { method: 'PUT', body: { ...change, current_password } }))
            setWeaker(null)
          }}
        />
      )}
      <form
        className="flex flex-wrap items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void server.save({ public_url: (address ?? s.public_url).trim() }, t('settings.saved'))
        }}
      >
        <Input label={t('server.publicUrl')} value={address ?? s.public_url} onChange={setAddress} placeholder="https://diary.example.com" hint={t('server.publicUrlHint')} className="min-w-60 flex-1" />
        <Button type="submit" busy={server.busy} className="mt-6">
          {t('common.save')}
        </Button>
      </form>
      <Feedback problem={server.problem} done={server.done} />

      <SubHead title={t('server.oidc')} />
      {oidc && (
        <p className="-mt-2 text-xs break-words text-muted">
          {oidc.configured ? t('server.oidcOn', { issuer: oidc.issuer }) : t('server.oidcOff')} · {t('server.redirect')}: <code className="font-mono">{oidc.redirect_uri}</code>
        </p>
      )}
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            setOidc(await api<Oidc>('/api/oidc/config', { method: 'PUT', body: form }))
            setForm((current) => ({ ...current, client_secret: '' }))
          }, t('settings.saved'))
        }}
      >
        <Input label={t('server.oidcIssuer')} value={form.issuer} onChange={(issuer) => setForm({ ...form, issuer })} placeholder="https://auth.example.com/application/o/nexdiary/" className="sm:col-span-2" />
        <Input label={t('server.clientId')} value={form.client_id} onChange={(client_id) => setForm({ ...form, client_id })} />
        <Input label={t('server.clientSecret')} value={form.client_secret} onChange={(client_secret) => setForm({ ...form, client_secret })} type="password" autoComplete="new-password" placeholder={oidc?.configured ? t('server.secretKept') : ''} />
        <Input label={t('server.oidcName')} value={form.provider_name} onChange={(provider_name) => setForm({ ...form, provider_name })} placeholder="authentik" />
        <div className="sm:col-span-2">
          <Toggle label={t('server.oidcAutoCreate')} hint={t('server.oidcAutoCreateHint')} checked={form.auto_create} onChange={(auto_create) => setForm({ ...form, auto_create })} />
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" primary busy={busy}>
            {t('common.save')}
          </Button>
          {oidc?.configured && (
            <Button
              danger
              busy={busy}
              onClick={() =>
                void run(async () => {
                  await api('/api/oidc/config', { method: 'DELETE' })
                  await loadOidc()
                })
              }
            >
              {t('server.oidcRemove')}
            </Button>
          )}
        </div>
      </form>

      <SubHead title={t('server.authentik.title')} text={t('server.authentik.text')} />
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            setSteps(await api<Steps>('/api/oidc/authentik/setup', { method: 'POST', body: authentik }))
            setAuthentik({ ...authentik, token: '' })
            await loadOidc()
          })
        }}
      >
        <Input label={t('server.authentik.url')} value={authentik.url} onChange={(url) => setAuthentik({ ...authentik, url })} placeholder="https://auth.example.com" />
        <Input label={t('server.authentik.token')} value={authentik.token} onChange={(token) => setAuthentik({ ...authentik, token })} type="password" autoComplete="new-password" />
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button type="submit" busy={busy} disabled={!authentik.url.trim() || !authentik.token.trim()}>
            {t('server.authentik.run')}
          </Button>
          <a href="/api/oidc/authentik/blueprint" className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-line px-4 text-sm font-semibold text-ink-2 hover:bg-sheet-2">
            <Download size={16} />
            {t('server.authentik.blueprint')}
          </a>
        </div>
      </form>
      {steps && (
        <ol className="space-y-1 text-xs" data-testid="authentik-steps">
          {steps.steps.map((step) => (
            <li key={step.key} className={step.ok ? 'text-accent' : 'text-bad'}>
              {step.ok ? '✓' : '✗'} {t(`authentik.step.${step.key}`, { defaultValue: step.key })}: {step.detail}
            </li>
          ))}
        </ol>
      )}
      <Feedback problem={problem} done={done} />
    </Card>
  )
}

/** How much each person may keep in photos and drafts; 0 is no limit. */
export function StorageCard({ server }: { server: Server }) {
  const { t } = useTranslation()
  const [value, setValue] = useState<string | null>(null)
  const s = server.settings
  if (!s) return null
  return (
    <Card id="storage" icon={Database} title={t('server.storage')} text={t('server.storageHint')}>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const gb = Math.max(0, Math.min(10000, Number((value ?? String(s.storage_per_person_gb)).replace(',', '.')) || 0))
          void server.save({ storage_per_person_gb: gb }, t('settings.saved'))
          setValue(null)
        }}
      >
        <Input label={t('server.storageGb')} type="number" min={0} max={10000} value={value ?? String(s.storage_per_person_gb)} onChange={setValue} className="w-32" />
        <Button type="submit" busy={server.busy}>
          {t('common.save')}
        </Button>
      </form>
      <Feedback problem={server.problem} done={server.done} />
    </Card>
  )
}

/** The switch for API tokens, and every token there is: who made it, when it was used; blocked for good on request
 * (every way out needs a latch). Never the token itself. */
export function ApiTokensCard({ server }: { server: Server }) {
  const { t, i18n } = useTranslation()
  const { busy, problem, run } = useAction()
  const [tokens, setTokens] = useState<AnyApiToken[] | null>(null)
  const [blocking, setBlocking] = useState<AnyApiToken | null>(null)
  const load = useCallback(() => {
    apiTokensApi.every().then(setTokens, () => setTokens(null))
  }, [])
  useEffect(load, [load])
  const s = server.settings
  if (!s) return null
  return (
    <Card id="api-tokens" icon={Plug} title={t('server.apiTokens.title')} text={t('server.apiTokens.text')}>
      <Toggle label={t('server.apiTokens.allow')} hint={t('server.apiTokens.allowHint')} checked={s.api_tokens_allowed} onChange={(api_tokens_allowed) => void server.save({ api_tokens_allowed })} />
      {tokens && tokens.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line text-sm" data-testid="admin-api-tokens">
          {tokens.map((token) => (
            <li key={token.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1">
                <code className="font-mono text-xs font-semibold">{token.prefix}…</code>
                <span className="block text-xs text-muted">
                  {token.account} · {token.last_used_at ? new Date(token.last_used_at).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' }) : t('apiTokens.unused')}
                </span>
              </span>
              {token.blocked ? (
                <span className="text-xs font-semibold text-bad">{t('server.apiTokens.blocked')}</span>
              ) : (
                <Button small danger busy={busy} onClick={() => setBlocking(token)} label={t('server.apiTokens.blockNamed', { name: token.prefix, account: token.account })}>
                  {t('server.apiTokens.block')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">{t('server.apiTokens.offHint')}</p>
      <Feedback problem={problem ?? server.problem} done={server.done} />
      {blocking && (
        <Confirm
          title={t('server.apiTokens.blockTitle', { name: blocking.prefix, account: blocking.account })}
          text={t('server.apiTokens.blockText')}
          confirm={t('server.apiTokens.block')}
          danger
          onCancel={() => setBlocking(null)}
          onConfirm={async () => {
            await run(async () => {
              await apiTokensApi.block(blocking.id)
              load()
            })
            setBlocking(null)
          }}
        />
      )}
    </Card>
  )
}

export function MailCard({ server }: { server: Server }) {
  const { t } = useTranslation()
  const s = server.settings
  const [draft, setDraft] = useState<Change>({})
  const [to, setTo] = useState('')
  const test = useAction()
  if (!s) return null
  const value = { ...s, ...draft }
  return (
    <Card id="mail" icon={Mail} title={t('server.mail')} text={t('server.mailHint')}>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          void server.save(draft, t('settings.saved')).then(() => setDraft({}))
        }}
      >
        <Input label={t('server.smtpHost')} value={value.smtp_host} onChange={(smtp_host) => setDraft({ ...draft, smtp_host })} placeholder="smtp.example.com" />
        <Input label={t('server.smtpPort')} type="number" value={String(value.smtp_port)} onChange={(port) => setDraft({ ...draft, smtp_port: Number(port) })} />
        <Select
          label={t('server.smtpSecurity')}
          value={value.smtp_security}
          onChange={(smtp_security) => setDraft({ ...draft, smtp_security })}
          options={[
            { value: 'starttls', label: 'STARTTLS' },
            { value: 'tls', label: 'TLS' },
            { value: 'none', label: t('server.none') },
          ]}
        />
        <Input label={t('server.smtpUser')} value={value.smtp_user} onChange={(smtp_user) => setDraft({ ...draft, smtp_user })} />
        <Input label={t('auth.password')} type="password" autoComplete="new-password" value={draft.smtp_password ?? ''} onChange={(smtp_password) => setDraft({ ...draft, smtp_password })} placeholder={s.smtp_password_set ? t('server.secretKept') : ''} />
        <Input label={t('server.smtpFrom')} value={value.smtp_from} onChange={(smtp_from) => setDraft({ ...draft, smtp_from })} placeholder="diary@example.com" />
        <div className="sm:col-span-2">
          <Button type="submit" primary busy={server.busy}>
            {t('common.save')}
          </Button>
        </div>
      </form>
      <Feedback problem={server.problem} done={server.done} />
      <SubHead title={t('server.mailTestTitle')} />
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void test.run(() => api('/api/settings/mail-test', { method: 'POST', body: { to } }), t('server.mailSent'))
        }}
      >
        <Input label={t('server.mailTest')} value={to} onChange={setTo} placeholder="jule@example.com" className="min-w-60 flex-1" />
        <Button type="submit" busy={test.busy} disabled={!to.trim()}>
          {t('server.send')}
        </Button>
      </form>
      <Feedback problem={test.problem} done={test.done} />
    </Card>
  )
}

type Backup = { name: string; size: number; created: string; kind: string; note: string; accounts: number; files: number; version: string; uploaded?: boolean }
type Brief = { usable: boolean; too_new: boolean; other_master_key: boolean; accounts: number; files: number; would_add: number; would_change: number; would_remove: number; damaged: string[]; created: string }

export function BackupsCard({ server }: { server: Server }) {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const [list, setList] = useState<Backup[]>([])
  const [brief, setBrief] = useState<(Brief & { name: string }) | null>(null)
  const [asking, setAsking] = useState<{ kind: 'restore' | 'download' | 'delete' | 'upload'; name: string; file?: File } | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const [keep, setKeep] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [uploaded, setUploaded] = useState(false)
  const action = useAction()
  const load = useCallback(() => {
    api<Backup[]>('/api/backups').then(setList, () => undefined)
  }, [])
  useEffect(load, [load])
  const s = server.settings
  if (!s) return null
  const size = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)
  const icon = 'rounded-full p-1.5 text-muted hover:bg-sheet hover:text-ink'
  return (
    <Card id="backups" icon={HardDrive} title={t('server.backups')} text={t('server.backupsHint')}>
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label={t('server.schedule')}
          value={s.backup_schedule}
          onChange={(backup_schedule) => void server.save({ backup_schedule })}
          options={[
            { value: 'off', label: t('server.off') },
            { value: 'daily', label: t('server.daily') },
            { value: 'weekly', label: t('server.weekly') },
          ]}
          className="w-48"
        />
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void server.save({ backup_keep: Math.max(1, Math.min(365, Number(keep ?? s.backup_keep) || 7)) }, t('settings.saved'))
          }}
        >
          <Input label={t('server.keep')} type="number" min={1} max={365} value={keep ?? String(s.backup_keep)} onChange={setKeep} className="w-28" />
          <Button type="submit" busy={server.busy}>
            {t('common.save')}
          </Button>
        </form>
      </div>
      <Feedback problem={server.problem} done={server.done} />
      <div className="flex flex-wrap gap-2">
        <Button
          primary
          busy={action.busy}
          onClick={() =>
            void action.run(async () => {
              await api('/api/backups', { method: 'POST', body: { note: '' } })
              load()
            }, t('server.backupMade'))
          }
        >
          {t('server.backupNow')}
        </Button>
        <input
          ref={picker}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          aria-label={t('server.uploadBackup')}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) setAsking({ kind: 'upload', name: file.name, file })
          }}
        />
        <Button onClick={() => picker.current?.click()}>
          <Upload size={16} />
          {t('server.uploadBackup')}
        </Button>
      </div>
      <p className="text-xs text-muted">{t('server.withoutMasterKey')}</p>
      <ul className="space-y-2 text-sm">
        {list.length === 0 && <li className="text-muted">{t('server.noBackups')}</li>}
        {list.map((entry) => (
          <li key={entry.name} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-sheet-2/50 px-4 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{new Date(entry.created).toLocaleString(i18n.language)}</span>
              <span className="block text-xs text-muted">
                {entry.uploaded ? t('server.uploaded') : t(`server.kinds.${entry.kind}`)} · {t('server.backupContent', { accounts: t('server.countAccounts', { count: entry.accounts }), files: t('server.countFiles', { count: entry.files }) })} · {size(entry.size)} · {entry.version}
              </span>
            </span>
            <button type="button" className={icon} title={t('server.check')} aria-label={t('server.check')} onClick={() => void action.run(async () => setBrief({ ...(await api<Brief>(`/api/backups/${entry.name}/check`, { method: 'POST' })), name: entry.name }))}>
              <ShieldCheck size={16} />
            </button>
            <button type="button" className={icon} title={t('server.download')} aria-label={t('server.download')} onClick={() => setAsking({ kind: 'download', name: entry.name })}>
              <Download size={16} />
            </button>
            <button type="button" className={icon} title={t('server.restore')} aria-label={t('server.restore')} onClick={() => setAsking({ kind: 'restore', name: entry.name })}>
              <RotateCcw size={16} />
            </button>
            <button type="button" className={icon + ' hover:text-bad'} title={t('server.deleteBackup')} aria-label={t('server.deleteBackup')} onClick={() => setAsking({ kind: 'delete', name: entry.name })}>
              <Trash2 size={16} />
            </button>
          </li>
        ))}
      </ul>
      {brief && (
        <p className={'rounded-xl border px-4 py-3 text-sm ' + (brief.usable ? 'border-accent/40 bg-accent-soft/50' : 'border-bad/40 bg-bad/10 text-bad')}>
          {brief.usable
            ? t('server.checkOk', { accounts: t('server.countAccounts', { count: brief.accounts }), files: t('server.countFiles', { count: brief.files }), add: t('server.countFiles', { count: brief.would_add }), remove: t('server.countFiles', { count: brief.would_remove }) })
            : brief.too_new
              ? t('server.checkNewer')
              : brief.other_master_key
                ? t('server.checkOtherKey')
                : t('server.checkBad')}
        </p>
      )}
      {uploaded && <p className="rounded-xl border border-accent/40 bg-accent-soft/50 px-4 py-3 text-sm">{t('server.uploadedHint')}</p>}
      {restarting && <p className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">{t('server.restarting')}</p>}
      <Feedback problem={action.problem} done={action.done} />
      {asking && (
        <Confirm
          title={t(`server.confirm.backup_${asking.kind}.title`)}
          text={t(`server.confirm.backup_${asking.kind}.text`)}
          confirm={t(`server.confirm.backup_${asking.kind}.button`)}
          danger={asking.kind !== 'download'}
          password={me?.sign_in === 'password'}
          onCancel={() => setAsking(null)}
          onConfirm={async (password) => {
            if (asking.kind === 'download') {
              const blob = await api<Blob>(`/api/backups/${asking.name}/download`, { method: 'POST', body: { password }, blob: true })
              saveAsFile(asking.name, blob)
            }
            if (asking.kind === 'delete') {
              await api(`/api/backups/${asking.name}`, { method: 'DELETE', body: { password } })
              load()
            }
            if (asking.kind === 'upload' && asking.file) {
              await api('/api/backups/upload', { method: 'POST', raw: asking.file, headers: { 'X-Nexdiary-Password': passwordHeader(password) } })
              load()
              setUploaded(true)
            }
            if (asking.kind === 'restore') {
              await api(`/api/backups/${asking.name}/restore`, { method: 'POST', body: { password } })
              setRestarting(true)
              window.setTimeout(() => window.location.reload(), 8000)
            }
            setAsking(null)
          }}
        />
      )}
    </Card>
  )
}

type Locale = { code: string; name: string; keys: number }

export function LanguagesCard() {
  const { t } = useTranslation()
  const [list, setList] = useState<Locale[]>([])
  const [code, setCode] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const action = useAction()
  const load = useCallback(() => {
    api<Locale[]>('/api/locales').then((rows) => setList(rows.sort(byName)), () => undefined)
  }, [])
  useEffect(load, [load])
  const chip = 'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold'
  return (
    <Card id="languages" icon={Languages} title={t('server.languages')} text={t('server.languagesHint')}>
      <div className="flex flex-wrap gap-2">
        <span className={chip + ' border-line text-ink-2'}>Deutsch · {t('server.builtIn')}</span>
        <span className={chip + ' border-line text-ink-2'}>English · {t('server.builtIn')}</span>
        {list.map((entry) => (
          <span key={entry.code} className={chip + ' border-accent/40 text-ink'}>
            {entry.name} ({entry.code}) · {t('server.texts', { count: entry.keys })}
            <button
              type="button"
              aria-label={t('server.removeLanguage', { name: entry.name })}
              className="text-muted hover:text-bad"
              onClick={() =>
                void action.run(async () => {
                  await api(`/api/locales/${entry.code}`, { method: 'DELETE' })
                  forgetAddedLanguages()
                  load()
                })
              }
            >
              <Trash2 size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Button onClick={() => saveAsFile('nexdiary-language-template.json', templateFile())}>
          <Download size={16} />
          {t('server.template')}
        </Button>
        <Input label={t('server.languageCode')} value={code} onChange={(value) => setCode(value.trim())} placeholder="es" className="w-28" />
        <Button disabled={!code} busy={action.busy} onClick={() => file.current?.click()}>
          <Upload size={16} />
          {t('server.upload')}
        </Button>
        <input
          ref={file}
          type="file"
          accept="application/json,.json"
          aria-label={t('server.upload')}
          className="hidden"
          onChange={(e) => {
            const chosen = e.target.files?.[0]
            e.target.value = ''
            if (!chosen) return
            void action.run(async () => {
              await api(`/api/locales/${encodeURIComponent(code)}`, { method: 'PUT', raw: chosen })
              forgetAddedLanguages()
              load()
            }, t('server.languageAdded'))
          }}
        />
      </div>
      <Feedback problem={action.problem} done={action.done} />
    </Card>
  )
}

type LogLine = { time: string; level: string; logger: string; message: string }
type LogMode = { mode: string; until: string | null; fixed_by_env: boolean; modes: string[] }

export function LogCard() {
  const { t } = useTranslation()
  const [lines, setLines] = useState<LogLine[] | null>(null)
  const [level, setLevel] = useState('')
  const [words, setWords] = useState('')
  const [mode, setMode] = useState<LogMode | null>(null)
  const [clearing, setClearing] = useState(false)
  const action = useAction()
  const load = useCallback(() => {
    api<LogLine[]>('/api/logs', { query: { level: level || undefined, search: words.trim() || undefined, limit: 300 } }).then(setLines, () => undefined)
  }, [level, words])
  useEffect(() => {
    const timer = window.setTimeout(load, 250)
    return () => window.clearTimeout(timer)
  }, [load])
  useEffect(() => {
    api<LogMode>('/api/logs/level').then(setMode, () => undefined)
  }, [])
  const tone = (line: LogLine) => (line.level === 'ERROR' || line.level === 'CRITICAL' ? 'text-bad' : line.level === 'WARNING' ? 'text-warn' : '')
  return (
    <Card id="log" icon={ScrollText} title={t('server.log')} text={t('server.logHint')}>
      <div className="flex flex-wrap items-end gap-2">
        <Select
          label={t('server.level')}
          value={level}
          onChange={setLevel}
          options={[
            { value: '', label: t('server.allLevels') },
            { value: 'INFO', label: 'INFO' },
            { value: 'WARNING', label: 'WARNING' },
            { value: 'ERROR', label: 'ERROR' },
          ]}
          className="w-40"
        />
        <Input label={t('server.logSearch')} value={words} onChange={setWords} className="min-w-40 flex-1" />
        <Button onClick={load}>{t('server.refresh')}</Button>
      </div>
      <div className="max-h-[28rem] overflow-auto rounded-xl border border-line font-mono text-xs" role="log">
        {lines?.length === 0 && <p className="px-4 py-2.5 text-muted">{t('server.logEmpty')}</p>}
        {lines?.map((line, index) => (
          <div key={index} className={'flex gap-4 border-b border-line px-4 py-2 break-words whitespace-pre-wrap last:border-b-0 ' + tone(line)}>
            <span className="w-36 shrink-0 text-muted">{line.time}</span>
            <span className="min-w-0">
              {line.level} <span className="text-muted">{line.logger}</span> {line.message}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {mode && (
          <label className="block text-sm">
            <span className="font-semibold">{t('server.detail')}</span>
            <select
              className="mt-1 block h-11 w-56 rounded-xl border border-line bg-sheet px-3 text-ink"
              value={mode.mode}
              disabled={mode.fixed_by_env}
              onChange={(e) => void action.run(async () => setMode(await api<LogMode>('/api/logs/level', { method: 'PUT', body: { mode: e.target.value, minutes: e.target.value === 'detailed' || e.target.value === 'trace' ? 60 : 0 } })))}
            >
              {mode.modes.map((value) => (
                <option key={value} value={value}>
                  {t(`server.levels.${value}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        <a href="/api/logs/download" className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-line px-4 text-sm font-semibold text-ink-2 hover:bg-sheet-2">
          <Download size={16} />
          {t('server.download')}
        </a>
        <Button onClick={() => setClearing(true)}>
          <Trash2 size={15} /> {t('server.logClear')}
        </Button>
      </div>
      {mode?.until && <p className="text-xs text-muted">{t('server.logUntil', { time: new Date(mode.until).toLocaleTimeString() })}</p>}
      <Feedback problem={action.problem} done={action.done} />
      {clearing && (
        <Confirm
          title={t('server.logClear')}
          text={t('server.logClearText')}
          confirm={t('server.logClear')}
          danger
          onCancel={() => setClearing(false)}
          onConfirm={async () => {
            await api('/api/logs', { method: 'DELETE' })
            setClearing(false)
            setLines([])
          }}
        />
      )}
    </Card>
  )
}
