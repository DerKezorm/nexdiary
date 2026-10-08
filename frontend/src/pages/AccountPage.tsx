/**
 * The own account in tabs, everything personal in one place: Profile (picture, display name, name, role, mail
 * address, language), Security (password, second factor, the link to the provider, the notice of a new sign-in),
 * Look (colour, light or dark, the layout of "Today" and of the journal, where a phone starts), Writing (the values
 * and the writing prompts), Reminders (Web Push on this device and the others, when to remind), AI (the own switch,
 * and what the operator set up) and Connections (the own Immich, API tokens for programs). The tab stands in the
 * address (`?tab=`). Settings are the operator's.
 */
import { Bell, Camera, Eye, KeyRound, PenLine, Plug, ShieldCheck, Sparkles, Trash2, User } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { aiApi, api, authApi, type Autowrite, type Me, type Methods } from '../api/client'
import { ApiTokens } from '../components/ApiTokens'
import { Avatar } from '../components/Avatar'
import { providerName } from '../lib/aiProviders'
import { useAiState } from '../state/ai'
import { useAuth } from '../state/auth'
import { ImmichCard } from './settings/ImmichCards'
import { GoalCard, JournalCard, LanguageCard, LayoutCard, LooksCard, PhoneCard } from './settings/PersonalCards'
import { PromptsCard } from './settings/PromptsCard'
import { RemindersPart } from './settings/PushCards'
import { DevicesCard, PasskeysCard, SecondFactorCard } from './settings/SecurityCards'
import { Button, Card, Confirm, Feedback, Input, Segment, Select, TabRow, Toggle, useAction, type Tab } from './settings/ui'
import { ValuesCard } from './settings/ValuesCard'

type Part = 'profile' | 'security' | 'looks' | 'writing' | 'reminders' | 'ai' | 'connections'
const PARTS: Part[] = ['profile', 'security', 'looks', 'writing', 'reminders', 'ai', 'connections']

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
    { value: 'looks', label: t('me.tabs.looks'), icon: Eye },
    { value: 'writing', label: t('me.tabs.writing'), icon: PenLine },
    { value: 'reminders', label: t('me.tabs.reminders'), icon: Bell },
    { value: 'ai', label: t('me.tabs.ai'), icon: Sparkles },
    { value: 'connections', label: t('me.tabs.connections'), icon: Plug },
  ]
  return (
    <div className="page space-y-5 pt-8 pb-28 lg:pb-12">
      <h1 className="font-display text-3xl font-semibold tracking-tight">{t('me.title')}</h1>
      <TabRow tabs={tabs} active={part} label={t('me.title')} onChange={(value) => setParams(value === 'profile' ? {} : { tab: value }, { replace: true })} />
      <div className="space-y-6 pt-1">
        {part === 'profile' && (
          <>
            <Profile me={me} />
            <LanguageCard />
          </>
        )}
        {part === 'security' && <Security me={me} />}
        {part === 'looks' && (
          <>
            <LooksCard />
            <PhoneCard />
            <LayoutCard />
            <JournalCard />
          </>
        )}
        {part === 'writing' && (
          <>
            <GoalCard />
            <ValuesCard />
            <PromptsCard />
          </>
        )}
        {part === 'reminders' && <RemindersPart me={me} />}
        {part === 'ai' && <AiPart me={me} />}
        {part === 'connections' && (
          <>
            <ImmichCard />
            <ApiTokens />
          </>
        )}
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
      {me.ai_allowed === false && (
        <p className="mt-4 rounded-xl bg-sheet-2 px-4 py-3 text-sm text-ink-2" role="status" data-ai-not-allowed>
          {t('me.ai.notAllowed')}
        </p>
      )}
      {ai && me.ai_allowed !== false && (
        <div className="mt-4 rounded-xl bg-sheet-2 px-4 py-3 text-sm">
          <p>
            <span className="font-semibold">{t('me.ai.byOperator')}</span> {providerName(provider, t)}
            {provider === 'local' && ai.model && ` (${ai.model})`}
          </p>
          <p className="mt-1 text-ink-2">{t(`server.ai.${provider}Note`)}</p>
        </div>
      )}
      {ai && me.ai_allowed !== false && mine && ai.provider !== 'none' && ai.auto_allowed && <AutoWrite me={me} to={ai.to} model={ai.model} />}
      <Feedback problem={action.problem} />
    </Card>
  )
}

const MORNING_TIMES = Array.from({ length: 16 }, (_, index) => {
  const minutes = 4 * 60 + index * 30
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
})
const AUTOWRITE_OFF: Autowrite = { on: false, time: '07:00', length: 'long' }

/**
 * "Automatisch ausformulieren": off from the start, only where the operator opened it. Switching it on asks first and
 * says where the notes go, without a press of a button, every morning; the server wants that confirmation too. The
 * result is a draft that waits for the person, never a page.
 */
export function AutoWrite({ me, to, model }: { me: Me; to: string; model: string }) {
  const { t } = useTranslation()
  const { setMe } = useAuth()
  const action = useAction()
  const [asking, setAsking] = useState(false)
  const choice = me.profile.autowrite ?? AUTOWRITE_OFF
  const keep = (autowrite: Autowrite) => setMe({ ...me, profile: { ...me.profile, autowrite } })
  const change = (next: Partial<Autowrite> & { confirmed?: boolean }) => action.run(async () => keep(await aiApi.autowrite(next)))
  const times = MORNING_TIMES.includes(choice.time) ? MORNING_TIMES : [...MORNING_TIMES, choice.time].sort()
  return (
    <div className="mt-4 border-t border-line pt-4" data-autowrite>
      <Toggle
        label={t('autowrite.title')}
        hint={t('autowrite.hint')}
        checked={choice.on}
        onChange={(on) => (on ? setAsking(true) : void change({ on: false }))}
      />
      {choice.on && (
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <Select label={t('autowrite.time')} value={choice.time} options={times.map((time) => ({ value: time, label: time }))} onChange={(time) => void change({ time })} className="w-36" />
          <div>
            <span className="mb-1 block text-sm font-semibold">{t('autowrite.length')}</span>
            <Segment
              label={t('autowrite.length')}
              value={choice.length}
              options={[
                { value: 'short', label: t('write.lengthShort') },
                { value: 'long', label: t('write.lengthLong') },
              ]}
              onChange={(length) => void change({ length })}
            />
          </div>
        </div>
      )}
      <p className="mt-3 text-xs leading-relaxed text-muted">{t('autowrite.note')}</p>
      <Feedback problem={action.problem} values={action.values} />
      {asking && (
        <Confirm
          title={t('autowrite.confirmTitle')}
          text={to ? t('autowrite.confirmCloud', { to }) : t('autowrite.confirmLocal', { model })}
          confirm={t('autowrite.confirm')}
          onCancel={() => setAsking(false)}
          onConfirm={async () => {
            keep(await aiApi.autowrite({ on: true, confirmed: true }))
            setAsking(false)
          }}
        />
      )}
    </div>
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
  // Until the second factor is set up, the server answers nothing else: only its cards are shown.
  const restricted = Boolean(me.second_factor_setup_required)
  useEffect(() => {
    if (!restricted) authApi.methods().then(setMethods, () => setMethods(null))
  }, [restricted])
  const provider = methods?.oidc_name || 'OpenID Connect'
  if (restricted)
    return (
      <>
        <p role="note" className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm font-semibold text-warn">
          {t('me.setupFirst')}
        </p>
        <SecondFactorCard me={me} />
        <PasskeysCard me={me} />
      </>
    )
  return (
    <>
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

      <SecondFactorCard me={me} />
      <PasskeysCard me={me} />

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

      <DevicesCard me={me} />
    </>
  )
}
