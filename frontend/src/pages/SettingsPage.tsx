/**
 * Settings in tabs, as the mock (and nexlore): General and Look for everyone (Look is the own account's), Server for
 * the operator with a second row for its parts. The tab is in the address (`?tab=server&sub=backups`), so a link can
 * point at one; a tab someone may not see falls back to General. The own account is `AccountPage.tsx`.
 */
import { BellRing, Database, Eye, Globe, HardDrive, Image, KeyRound, Languages, ListChecks, Mail, Palette, Plug, ScrollText, Shield, Smartphone, Sparkles, Users } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { authApi, type JournalLook, type Layout, type Me, type Profile } from '../api/client'
import { JournalWire, LayoutWire } from '../components/Wires'
import { changeLanguage, languageOptions, type LanguageOption } from '../i18n'
import { applyMode, storedMode, type Mode } from '../lib/theme'
import { useAuth } from '../state/auth'
import { AiCard } from './settings/AiCard'
import { ImmichCard, ImmichServerCard } from './settings/ImmichCards'
import { PromptsCard } from './settings/PromptsCard'
import { PushServerCard } from './settings/PushCards'
import { AccountsCard, ApiTokensCard, BackupsCard, LanguagesCard, LogCard, MailCard, SignInCard, StorageCard, useServerSettings } from './settings/ServerCards'
import { Card, Feedback, Segment, TabRow, Toggle, useAction, type Tab } from './settings/ui'
import { ValuesCard } from './settings/ValuesCard'

type Top = 'general' | 'looks' | 'server'
type Part = 'accounts' | 'signin' | 'ai' | 'push' | 'immich' | 'mail' | 'api' | 'backups' | 'languages' | 'log'
const TOPS: Top[] = ['general', 'looks', 'server']
const PARTS: Part[] = ['accounts', 'signin', 'ai', 'push', 'immich', 'mail', 'api', 'backups', 'languages', 'log']
const TOP_ICON = { general: Globe, looks: Eye, server: Shield }
const PART_ICON = { accounts: Users, signin: KeyRound, ai: Sparkles, push: BellRing, immich: Image, mail: Mail, api: Plug, backups: HardDrive, languages: Languages, log: ScrollText }

export function SettingsPage() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [params, setParams] = useSearchParams()
  const operator = me?.role === 'operator'
  const asked = params.get('tab') as Top | null
  const top: Top = asked && TOPS.includes(asked) && (asked !== 'server' || operator) ? asked : 'general'
  const askedPart = params.get('sub') as Part | null
  const part: Part = askedPart && PARTS.includes(askedPart) ? askedPart : 'accounts'
  const go = (next: Top, sub?: Part) => setParams(next === 'general' ? {} : sub ? { tab: next, sub } : { tab: next }, { replace: true })

  const tops: Tab<Top>[] = TOPS.filter((value) => value !== 'server' || operator).map((value) => ({ value, label: t(`settings.tabs.${value}`), icon: TOP_ICON[value] }))
  const parts: Tab<Part>[] = PARTS.map((value) => ({ value, label: t(`settings.parts.${value}`), icon: PART_ICON[value] }))

  return (
    <div className="page space-y-5 pt-8 pb-28 lg:pb-12">
      <h1 className="font-display text-3xl font-semibold tracking-tight">{t('settings.title')}</h1>
      <TabRow tabs={tops} active={top} onChange={(value) => go(value)} label={t('settings.title')} />
      {top === 'server' && <TabRow under tabs={parts} active={part} onChange={(value) => go('server', value)} label={t('settings.tabs.server')} />}
      <div className="space-y-6 pt-1">
        {top === 'general' && (
          <>
            <LanguageCard />
            <ValuesCard />
            <PromptsCard />
            <ImmichCard />
          </>
        )}
        {top === 'looks' && (
          <>
            <LooksCard />
            <PhoneCard />
            <LayoutCard />
            <JournalCard />
          </>
        )}
        {top === 'server' && <ServerPart part={part} />}
      </div>
    </div>
  )
}

/** One part of the server, for the operator. */
function ServerPart({ part }: { part: Part }) {
  const server = useServerSettings()
  switch (part) {
    case 'accounts':
      return (
        <div className="space-y-6">
          <AccountsCard />
          <StorageCard server={server} />
        </div>
      )
    case 'signin':
      return <SignInCard server={server} />
    case 'ai':
      return <AiCard />
    case 'push':
      return <PushServerCard />
    case 'immich':
      return <ImmichServerCard />
    case 'mail':
      return <MailCard server={server} />
    case 'api':
      return <ApiTokensCard server={server} />
    case 'backups':
      return <BackupsCard server={server} />
    case 'languages':
      return <LanguagesCard />
    case 'log':
      return <LogCard />
  }
}

function LanguageCard() {
  const { t, i18n } = useTranslation()
  const { setMe } = useAuth()
  const [options, setOptions] = useState<LanguageOption[]>([])
  useEffect(() => {
    let alive = true
    void languageOptions().then((list) => alive && setOptions(list))
    return () => {
      alive = false
    }
  }, [])
  return (
    <Card icon={Globe} title={t('settings.language.title')} text={t('settings.language.text')}>
      <select
        aria-label={t('settings.language.title')}
        value={i18n.language}
        onChange={(e) => {
          const code = e.target.value
          void changeLanguage(code)
          // Kept with the account, so the next browser speaks it too.
          void authApi.language(code).then(setMe, () => undefined)
        }}
        className="h-11 rounded-xl border border-line bg-sheet px-3 text-ink"
      >
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.name}
          </option>
        ))}
      </select>
    </Card>
  )
}

/** Light, dark or as the system, kept with the account (the colours and the layout come later). */
function LooksCard() {
  const { t } = useTranslation()
  const { me, setMe } = useAuth()
  const [mode, setMode] = useState<Mode>(me?.profile.mode ?? storedMode())
  const action = useAction()
  return (
    <Card icon={Palette} title={t('settings.looks.title')} text={t('settings.looks.text')}>
      <Segment
        label={t('theme.group')}
        value={mode}
        onChange={(value) => {
          applyMode(value)
          setMode(value)
          void action.run(async () => {
            const profile = await authApi.preferences({ mode: value })
            if (me) setMe({ ...me, profile } as Me)
          })
        }}
        options={[
          { value: 'system', label: t('theme.system') },
          { value: 'light', label: t('theme.light') },
          { value: 'dark', label: t('theme.dark') },
        ]}
      />
      <Feedback problem={action.problem} />
    </Card>
  )
}

/** Saves a profile choice with the account (never only in this browser) and shows it at once. */
function useProfileChoice() {
  const { me, setMe } = useAuth()
  const action = useAction()
  const choose = (change: Partial<Profile>) => {
    if (!me) return
    setMe({ ...me, profile: { ...me.profile, ...change } })
    void action.run(async () => {
      const profile = await authApi.preferences(change)
      setMe({ ...me, profile })
    }).then((worked) => worked || void authApi.me().then(setMe, () => undefined))
  }
  return { profile: me?.profile, choose, problem: action.problem }
}

/** Where a phone starts: on the quick note, or in the whole app. */
function PhoneCard() {
  const { t } = useTranslation()
  const { profile, choose, problem } = useProfileChoice()
  return (
    <Card icon={Smartphone} title={t('settings.phone.title')} text={t('settings.phone.text')}>
      <Toggle label={t('settings.phone.quickStart')} hint={t('settings.phone.quickStartHint')} checked={profile?.quick_start ?? true} onChange={(quick_start) => choose({ quick_start })} />
      <Feedback problem={problem} />
    </Card>
  )
}

const LAYOUTS: Layout[] = ['page', 'columns', 'chat']

/** The layout of "Today", chosen from three sketches. */
function LayoutCard() {
  const { t } = useTranslation()
  const { profile, choose, problem } = useProfileChoice()
  return (
    <Card icon={ListChecks} title={t('settings.layout.title')} text={t('settings.layout.text')}>
      <div className="grid gap-3 sm:grid-cols-3">
        {LAYOUTS.map((layout) => (
          <Choice key={layout} on={(profile?.layout ?? 'page') === layout} onClick={() => choose({ layout })} title={t(`settings.layout.${layout}.name`)} text={t(`settings.layout.${layout}.idea`)}>
            <LayoutWire kind={layout} />
          </Choice>
        ))}
      </div>
      <Feedback problem={problem} />
    </Card>
  )
}

const JOURNALS: JournalLook[] = ['blog', 'timeline']

/** How the journal shows the days: as a blog or as a timeline. */
function JournalCard() {
  const { t } = useTranslation()
  const { profile, choose, problem } = useProfileChoice()
  return (
    <Card icon={Database} title={t('settings.journal.title')} text={t('settings.journal.text')}>
      <div className="grid gap-3 sm:grid-cols-2">
        {JOURNALS.map((journal) => (
          <Choice key={journal} on={(profile?.journal ?? 'blog') === journal} onClick={() => choose({ journal })} title={t(`settings.journal.${journal}.name`)} text={t(`settings.journal.${journal}.idea`)}>
            <JournalWire kind={journal} />
          </Choice>
        ))}
      </div>
      <Feedback problem={problem} />
    </Card>
  )
}

function Choice({ on, onClick, title, text, children }: { on: boolean; onClick: () => void; title: string; text: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className={`overflow-hidden rounded-2xl border text-left transition ${on ? 'border-accent ring-2 ring-accent' : 'border-line hover:border-accent/50'}`}>
      <span className="block bg-sheet-2/60 px-5 py-5">{children}</span>
      <span className="block border-t border-line px-4 py-3">
        <span className="font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted">{text}</span>
      </span>
    </button>
  )
}
