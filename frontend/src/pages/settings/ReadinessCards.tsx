/**
 * Server, Sign-in: "Ready for the internet?", which nexdiary checks about itself each time the page opens. Server,
 * Backups: the encryption and "Save master key". Both as the mock; the server checks, the card says what it means.
 */
import { AlertTriangle, Check, Fingerprint, KeyRound, Shield, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, ApiError, passkeyApi, type Readiness } from '../../api/client'
import { Dialog } from '../../components/Dialog'
import { answerWithPasskey, passkeysAvailable } from '../../lib/webauthn'
import { useAuth } from '../../state/auth'
import { Button, Card, Feedback, Input, saveAsFile, useAction } from './ui'

type Point = Readiness['points'][number]

/** The sentence of a point: some points have a sentence of their own for a special case. */
function sentence(point: Point): string {
  const { key, state, values } = point
  if (key === 'encryption' && state === 'bad') return values.missing ? 'ready.encryption.missing' : 'ready.encryption.bad'
  if (key === 'proxy' && state === 'ok') return values.forwarded ? 'ready.proxy.ok' : 'ready.proxy.direct'
  return `ready.${key}.${state}`
}

export function ReadinessCard() {
  const { t, i18n } = useTranslation()
  const [found, setFound] = useState<Readiness | null>(null)
  useEffect(() => {
    api<Readiness>('/api/settings/readiness').then(setFound, () => undefined)
  }, [])
  if (!found) return null
  const open = found.open
  return (
    <Card icon={Shield} title={t('ready.title')} text={t('ready.text')}>
      <div data-testid="ready-summary" className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold ${open ? 'bg-warn/15 text-warn' : 'bg-accent-soft text-accent'}`}>
        {open ? <AlertTriangle size={14} aria-hidden /> : <Check size={14} aria-hidden />}
        {open ? t('ready.open', { count: open }) : t('ready.allGood')}
      </div>
      <ul className="space-y-2">
        {found.points.map((point) => {
          const when = typeof point.values.when === 'string' ? new Date(point.values.when).toLocaleString(i18n.language, { dateStyle: 'long', timeStyle: 'short' }) : ''
          return (
            <li key={point.key} data-state={point.state} className="flex gap-3 rounded-xl border border-line bg-sheet-2/50 px-4 py-3 text-sm">
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${point.state === 'ok' ? 'bg-accent text-accent-ink' : point.state === 'warn' ? 'bg-warn text-white' : 'bg-bad text-white'}`}
                aria-label={t(`ready.state.${point.state}`)}
              >
                {point.state === 'ok' ? <Check size={12} strokeWidth={3} /> : point.state === 'warn' ? <AlertTriangle size={11} strokeWidth={3} /> : <X size={12} strokeWidth={3} />}
              </span>
              <span className="min-w-0">
                <span className="font-semibold">{t(`ready.${point.key}.title`)}</span>
                <span className="block text-xs break-words text-muted">{t(sentence(point), { ...point.values, when })}</span>
              </span>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/** "Hauptschlüssel sichern": the password and the second factor once more, then the file. */
function SaveMasterKey({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const { me } = useAuth()
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const action = useAction()
  if (!me) return null
  const withPassword = me.sign_in === 'password'
  const factor = me.totp || me.passkeys > 0
  const fetchKey = async (body: Record<string, unknown>) => {
    const file = await api<Blob>('/api/settings/master-key', { method: 'POST', body: { current_password: password, ...body }, blob: true })
    saveAsFile('nexdiary-master.key', file)
    onSaved()
  }
  return (
    <Dialog title={t('server.masterKey.save')} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(() => fetchKey({ code: code.trim() }))
        }}
      >
        <p className="text-sm text-ink-2">{factor ? t('server.masterKey.confirmText') : t('server.masterKey.factorFirst')}</p>
        {factor && withPassword && <Input label={t('settings.ownPassword')} type="password" value={password} onChange={setPassword} autoComplete="current-password" autoFocus />}
        {factor && me.totp && <Input label={t('auth.code.label')} value={code} onChange={setCode} autoComplete="one-time-code" />}
        <Feedback problem={action.problem} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          {factor && me.passkeys > 0 && passkeysAvailable() && (
            <Button
              busy={action.busy}
              disabled={withPassword && !password}
              onClick={() =>
                void action.run(async () => {
                  const { options } = await passkeyApi.confirmBegin()
                  let credential
                  try {
                    credential = await answerWithPasskey(options)
                  } catch {
                    throw new ApiError(0, 'passkey_cancelled')
                  }
                  await fetchKey({ credential })
                })
              }
            >
              <Fingerprint size={16} /> {t('server.masterKey.withPasskey')}
            </Button>
          )}
          {factor && me.totp && (
            <Button type="submit" primary busy={action.busy} disabled={(withPassword && !password) || code.trim().length < 6}>
              {t('server.masterKey.download')}
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  )
}

/** "Verschlüsselung": what it protects against and what not, said plainly, and saving the master key. */
export function EncryptionCard({ savedAt, onSaved }: { savedAt: string | null; onSaved: () => void }) {
  const { t, i18n } = useTranslation()
  const [asking, setAsking] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  return (
    <Card id="encryption" icon={KeyRound} title={t('server.encryption.title')} text={t('server.encryption.text')}>
      <div className="inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-sm font-semibold text-accent">
        <Check size={14} aria-hidden /> {t('server.encryption.on')}
      </div>
      <p className="text-sm text-ink-2">
        {t('server.encryption.how1')} <code className="font-mono text-xs">/data/keys</code>
        {t('server.encryption.how2')}
      </p>
      <p className="text-sm text-ink-2">{t('server.encryption.honest')}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => setAsking(true)}>{t('server.masterKey.save')}</Button>
        <span className="text-xs text-muted" data-testid="master-key-saved">
          {savedAt ? t('server.masterKey.savedAt', { when: new Date(savedAt).toLocaleString(i18n.language, { dateStyle: 'long', timeStyle: 'short' }) }) : t('server.masterKey.never')}
        </span>
      </div>
      <Feedback problem={null} done={done} />
      {asking && (
        <SaveMasterKey
          onClose={() => setAsking(false)}
          onSaved={() => {
            setAsking(false)
            setDone(t('server.masterKey.saved'))
            onSaved()
          }}
        />
      )}
    </Card>
  )
}
