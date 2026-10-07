/**
 * Settings, for the operator only: the server in one row of tabs (accounts, sign-in, mail, AI, Immich, Web Push,
 * backups, languages, log, API). Everything personal is under "My account". The part is in the address
 * (`?tab=signin`), so a link can point at one. A member has no use for this page and is sent to their account;
 * the addresses of the time before the split (`?tab=server&sub=api`, `?tab=looks`, `?tab=general`) still lead
 * to the right place.
 */
import { BellRing, HardDrive, Image, KeyRound, Languages, Mail, Plug, ScrollText, Sparkles, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Navigate, useSearchParams } from 'react-router-dom'

import { useAuth } from '../state/auth'
import { AiCard } from './settings/AiCard'
import { ImmichServerCard } from './settings/ImmichCards'
import { PushServerCard } from './settings/PushCards'
import { EncryptionCard, ReadinessCard } from './settings/ReadinessCards'
import { AccountsCard, ApiTokensCard, BackupsCard, LanguagesCard, LogCard, MailCard, SignInCard, StorageCard, useServerSettings } from './settings/ServerCards'
import { TabRow, type Tab } from './settings/ui'

type Part = 'accounts' | 'signin' | 'mail' | 'ai' | 'immich' | 'push' | 'backups' | 'languages' | 'log' | 'api'
const PARTS: Part[] = ['accounts', 'signin', 'mail', 'ai', 'immich', 'push', 'backups', 'languages', 'log', 'api']
const PART_ICON = { accounts: Users, signin: KeyRound, mail: Mail, ai: Sparkles, immich: Image, push: BellRing, backups: HardDrive, languages: Languages, log: ScrollText, api: Plug }

/** Where an address of the old layout (`?tab=general`, `?tab=looks`) belongs now; the rest stays on this page. */
function movedTo(params: URLSearchParams): string | null {
  const tab = params.get('tab')
  if (tab === 'looks') return '/konto?tab=looks'
  if (tab === 'general') return '/konto?tab=writing'
  return null
}

export function SettingsPage() {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [params, setParams] = useSearchParams()
  if (!me) return null
  if (me.role !== 'operator') return <Navigate to="/konto" replace />
  const moved = movedTo(params)
  if (moved) return <Navigate to={moved} replace />
  // `?tab=server&sub=api` was how a part was named before; `?tab=api` is now.
  const asked = (params.get('tab') === 'server' ? params.get('sub') : params.get('tab')) as Part | null
  const part: Part = asked && PARTS.includes(asked) ? asked : 'accounts'
  const tabs: Tab<Part>[] = PARTS.map((value) => ({ value, label: t(`settings.parts.${value}`), icon: PART_ICON[value] }))
  return (
    <div className="page space-y-5 pt-8 pb-28 lg:pb-12">
      <h1 className="font-display text-3xl font-semibold tracking-tight">{t('settings.title')}</h1>
      <TabRow tabs={tabs} active={part} onChange={(value) => setParams(value === 'accounts' ? {} : { tab: value }, { replace: true })} label={t('settings.title')} />
      <div className="space-y-6 pt-1">
        <ServerPart part={part} />
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
      return (
        <div className="space-y-6">
          <ReadinessCard />
          <SignInCard server={server} />
        </div>
      )
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
      return (
        <div className="space-y-6">
          <EncryptionCard
            savedAt={server.settings?.master_key_saved_at ?? null}
            onSaved={() => server.settings && server.setSettings({ ...server.settings, master_key_saved_at: new Date().toISOString() })}
          />
          <BackupsCard server={server} />
        </div>
      )
    case 'languages':
      return <LanguagesCard />
    case 'log':
      return <LogCard />
  }
}

