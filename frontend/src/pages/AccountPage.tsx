/**
 * The own account in tabs, everything personal in one place: Profile (picture, display name, name, role, mail
 * address, language), Security (password, second factor, the link to the provider, the notice of a new sign-in),
 * Look (colour, light or dark, the layout of "Today" and of the journal, where a phone starts), Writing (the values,
 * the writing prompts, the templates and taking part in the family question), Reminders (Web Push on this device and the others, when to remind), AI (the own switch,
 * and what the operator set up) and Connections (the own Immich, API tokens for programs). The tab stands in the
 * address (`?tab=`). Settings are the operator's.
 */
import { Bell, Camera, Eye, KeyRound, PenLine, Plug, ShieldCheck, Sparkles, Trash2, User } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { aiApi, api, authApi, type Autowrite, type Me, type MyProvider } from '../api/client'
import { ApiTokens } from '../components/ApiTokens'
import { Avatar } from '../components/Avatar'
import { providerName } from '../lib/aiProviders'
import { signInErrorText } from '../lib/errors'
import { go } from '../lib/providers'
import { useAiState } from '../state/ai'
import { useAuth } from '../state/auth'
import { ImmichCard } from './settings/ImmichCards'
import { FamilyCard, GoalCard, JournalCard, LanguageCard, LayoutCard, LooksCard, PhoneCard } from './settings/PersonalCards'
import { PromptsCard } from './settings/PromptsCard'
import { RemindersPart } from './settings/PushCards'
import { DevicesCard, PasskeysCard, SecondFactorCard } from './settings/SecurityCards'
import { TemplatesCard } from './settings/TemplatesCard'
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
            <TemplatesCard />
            <FamilyCard />
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
  const [pw, setPw] = useState({ current: '', next: '', again: '' })
  const password = useAction()
  const [unsent, setUnsent] = useState<string | null>(null)
  // Until the second factor is set up, the server answers nothing else: only its cards are shown.
  const restricted = Boolean(me.second_factor_setup_required)
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

      <ProvidersCard me={me} />

      <DevicesCard me={me} />
    </>
  )
}

/**
 * Sign-in providers (blueprint 04, "Mein Konto → Sicherheit → Anmeldeanbieter"): a row per active provider with its
 * state and "Link" or "Unlink". Linking asks for the own password once more, then goes to the provider; the way back
 * lands here with `?linked=<slug>` or `?error=<code>`. An account without a password links nothing more and keeps its
 * last link (the server says `oidc_only_account`).
 */
function ProvidersCard({ me }: { me: Me }) {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const [providers, setProviders] = useState<MyProvider[] | null>(null)
  const [linking, setLinking] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const action = useAction()
  const [arrived] = useState(params.get('error'))
  const [linked] = useState(params.get('linked'))
  const load = () => authApi.myProviders().then(setProviders, () => setProviders([]))
  useEffect(() => {
    void load()
  }, [])
  if (!providers || providers.length === 0) return null
  const withPassword = me.sign_in === 'password'
  const linkedCount = providers.filter((entry) => entry.linked).length
  const linkedLabel = linked ? providers.find((entry) => entry.slug === linked)?.label : undefined
  return (
    <Card icon={ShieldCheck} title={t('oidc.account.title')} text={withPassword ? t('oidc.account.text') : undefined}>
      <ul className="divide-y divide-line rounded-xl border border-line" data-testid="my-providers">
        {providers.map((entry) => (
          <li key={entry.slug} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{entry.label}</span>
              <span className={`block text-xs ${entry.linked ? 'text-accent' : 'text-muted'}`}>
                {entry.linked ? t('oidc.account.linked') : t('oidc.account.notLinked')}
              </span>
            </span>
            {entry.linked ? (
              !withPassword && linkedCount <= 1 ? (
                <span className="text-xs text-muted">{t('oidc.account.only', { name: entry.label })}</span>
              ) : (
                <Button
                  small
                  busy={action.busy}
                  label={`${t('oidc.account.unlink')}: ${entry.label}`}
                  onClick={() =>
                    void action.run(async () => {
                      await authApi.unlink(entry.slug)
                      await load()
                    })
                  }
                >
                  {t('oidc.account.unlink')}
                </Button>
              )
            ) : (
              withPassword && (
                <Button small busy={action.busy} label={`${t('oidc.account.link')}: ${entry.label}`} onClick={() => setLinking(linking === entry.slug ? null : entry.slug)}>
                  {t('oidc.account.link')}
                </Button>
              )
            )}
            {linking === entry.slug && (
              <form
                className="flex basis-full flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void action.run(async () => {
                    const { url } = await authApi.linkStart(entry.slug, password)
                    go(url)
                  })
                }}
              >
                <Input label={t('auth.password')} type="password" value={password} onChange={setPassword} autoComplete="current-password" autoFocus className="min-w-52 flex-1" />
                <Button type="submit" primary busy={action.busy} disabled={!password}>
                  {t('oidc.account.link')}
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {arrived && !action.problem && (
        <p role="alert" className="rounded-xl border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
          {signInErrorText(arrived)}
        </p>
      )}
      <Feedback problem={action.problem} done={action.done ?? (linkedLabel ? t('me.oidc.linkedNow', { name: linkedLabel }) : null)} values={action.values} />
    </Card>
  )
}
