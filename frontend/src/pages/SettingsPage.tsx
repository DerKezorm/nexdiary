/**
 * Settings in tabs, as the mock (and nexlore): General and Look for everyone (Look is the own account's), Server for
 * the operator with a second row for its parts. The tab is in the address (`?tab=server&sub=backups`), so a link can
 * point at one; a tab someone may not see falls back to General. The own account is `AccountPage.tsx`.
 */
import { Eye, Globe, HardDrive, KeyRound, Languages, Mail, Palette, Plug, ScrollText, Shield, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { authApi, type Me } from '../api/client'
import { changeLanguage, languageOptions, type LanguageOption } from '../i18n'
import { applyMode, storedMode, type Mode } from '../lib/theme'
import { useAuth } from '../state/auth'
import { AccountsCard, ApiTokensCard, BackupsCard, LanguagesCard, LogCard, MailCard, SignInCard, useServerSettings } from './settings/ServerCards'
import { Card, Feedback, Segment, TabRow, useAction, type Tab } from './settings/ui'

type Top = 'general' | 'looks' | 'server'
type Part = 'accounts' | 'signin' | 'mail' | 'api' | 'backups' | 'languages' | 'log'
const TOPS: Top[] = ['general', 'looks', 'server']
const PARTS: Part[] = ['accounts', 'signin', 'mail', 'api', 'backups', 'languages', 'log']
const TOP_ICON = { general: Globe, looks: Eye, server: Shield }
const PART_ICON = { accounts: Users, signin: KeyRound, mail: Mail, api: Plug, backups: HardDrive, languages: Languages, log: ScrollText }

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
        {top === 'general' && <LanguageCard />}
        {top === 'looks' && <LooksCard />}
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
      return <AccountsCard />
    case 'signin':
      return <SignInCard server={server} />
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
