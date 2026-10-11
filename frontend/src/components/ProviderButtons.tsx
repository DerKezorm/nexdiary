/**
 * The sign-in providers as buttons, in the order of the operator's list, with the line "or" above them: on the sign-in
 * page "Sign in with …", on the invitation page "Continue with …" (the invitation travels along to the provider).
 * Words from the shared sign-in module (`oidc.login.*`, `oidc.invite.button`), the same in every nex app.
 */
import { useTranslation } from 'react-i18next'

import type { ProviderButton } from '../api/client'
import { go, startAddress } from '../lib/providers'

export function OrLine() {
  const { t } = useTranslation()
  return (
    <div className="my-5 flex items-center gap-3 text-xs text-muted">
      <span className="h-px flex-1 bg-line" />
      {t('oidc.login.or')}
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}

export function ProviderButtons({ providers, invite }: { providers: ProviderButton[]; /** The invitation's key: the buttons say "Continue with" and take it along. */ invite?: string }) {
  const { t } = useTranslation()
  if (providers.length === 0) return null
  return (
    <div className="space-y-2.5" data-testid="provider-buttons">
      {providers.map((provider) => (
        <button
          key={provider.slug}
          type="button"
          onClick={() => go(startAddress(provider.slug, { invite }))}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-full border border-line text-sm font-semibold hover:bg-sheet-2"
        >
          {invite ? t('oidc.invite.button', { name: provider.label }) : t('oidc.login.button', { name: provider.label })}
        </button>
      ))}
    </div>
  )
}
