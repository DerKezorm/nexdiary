/**
 * The own API tokens on the account page, under Connections, as nexlore's: for programs such as a dashboard card
 * (`/api/v1`). List, make, delete. A token is shown once, right after it was made, with the header line a program needs
 * and a command to try it; afterwards only its first characters.
 *
 * A token only reads, and never more than its account; it runs out after 30, 90 or 365 days, or never. A week before,
 * the list marks it. A token the operator blocked stays in the list, marked, until the account deletes it.
 */
import { Plug, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { apiTokensApi, type ApiToken } from '../api/client'
import { copyText } from '../lib/copy'
import { Button, Card, Feedback, Input, Segment, useAction } from '../pages/settings/ui'
import { useAuth } from '../state/auth'

/** Days until a token runs out; 'never' is the default. */
const LIFETIMES = ['never', '30', '90', '365'] as const
type Lifetime = (typeof LIFETIMES)[number]
const WEEK = 7 * 24 * 60 * 60 * 1000
/** What the API offers; the whole description is `docs/api.md`. */
const ROUTES = ['/api/v1/me']

/** One line to copy: what it is for, the text, and a button. */
function Line({ label, text, copied, onCopy }: { label: string; text: string; copied: boolean; onCopy: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted">
        <span className="flex-1">{label}</span>
        <Button small onClick={onCopy} label={t('apiTokens.copyNamed', { what: label })}>
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-lg bg-sheet px-2 py-1.5 font-mono text-[11px] leading-5 whitespace-pre">{text}</pre>
    </div>
  )
}

export function ApiTokens() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const [state, setState] = useState<{ allowed: boolean; tokens: ApiToken[] } | null>(null)
  const [making, setMaking] = useState(false)
  const [name, setName] = useState('')
  const [days, setDays] = useState<Lifetime>('never')
  const [shown, setShown] = useState<{ name: string; secret: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const action = useAction()
  // The moment of the last load, for "runs out soon": a render must not read the clock.
  const [now, setNow] = useState(0)
  const load = () =>
    apiTokensApi.list().then(
      (found) => {
        setState(found)
        setNow(Date.now())
      },
      () => setState(null),
    )
  useEffect(() => {
    void load()
  }, [])

  if (!state) return null
  const operator = me?.role === 'operator'
  if (!state.allowed)
    return (
      <Card id="api-tokens" icon={Plug} title={t('apiTokens.title')} text={t('apiTokens.text')}>
        <p className="text-sm text-ink-2" data-testid="api-tokens-off">
          {operator ? t('apiTokens.offForOperator') : t('apiTokens.off')}{' '}
          {operator && (
            <Link to="/einstellungen?tab=api" className="font-semibold text-accent underline decoration-accent/40 underline-offset-4">
              {t('apiTokens.offOperator')}
            </Link>
          )}
        </p>
      </Card>
    )

  const day = (value: string) => new Date(value).toLocaleDateString(i18n.language)
  const moment = (value: string) => new Date(value).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' })
  const header = (secret: string) => `Authorization: Bearer ${secret}`
  const curl = (secret: string) => `curl -H "Authorization: Bearer ${secret}" ${window.location.origin}/api/v1/me`
  const copy = (what: string, text: string) => void copyText(text).then((done) => done && setCopied(what))
  const ending = (token: ApiToken) => {
    if (!token.expires_at) return { text: t('apiTokens.never'), soon: false }
    const at = new Date(token.expires_at).getTime()
    if (at <= now) return { text: t('apiTokens.ranOut', { day: day(token.expires_at) }), soon: true }
    return { text: t('apiTokens.runsOut', { day: day(token.expires_at) }), soon: at - now <= WEEK }
  }

  return (
    <Card id="api-tokens" icon={Plug} title={t('apiTokens.title')} text={t('apiTokens.text')}>
      {shown && (
        <div className="rounded-xl border border-accent/40 bg-accent-soft/50 p-4 text-sm" data-testid="api-token-shown">
          <p className="font-semibold">{t('apiTokens.shownOnce', { name: shown.name })}</p>
          <Line label={t('apiTokens.token')} text={shown.secret} copied={copied === 'token'} onCopy={() => copy('token', shown.secret)} />
          <Line label={t('apiTokens.header')} text={header(shown.secret)} copied={copied === 'header'} onCopy={() => copy('header', header(shown.secret))} />
          <Line label={t('apiTokens.tryIt')} text={curl(shown.secret)} copied={copied === 'curl'} onCopy={() => copy('curl', curl(shown.secret))} />
          <Button small className="mt-3" onClick={() => setShown(null)}>
            {t('apiTokens.done')}
          </Button>
        </div>
      )}
      {state.tokens.length === 0 ? (
        <p className="text-sm text-muted">{t('apiTokens.none')}</p>
      ) : (
        <ul className="space-y-2">
          {state.tokens.map((token) => {
            const end = ending(token)
            return (
              <li key={token.id} className="flex items-center gap-3 rounded-xl border border-line bg-sheet-2/50 px-4 py-3 text-sm" data-testid="api-token">
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{token.name}</span> <code className="font-mono text-xs text-muted">{token.prefix}…</code>
                  <span className="block text-xs text-muted">
                    {token.blocked ? (
                      <span className="font-semibold text-bad" data-testid="api-token-blocked">
                        {t('apiTokens.blocked')}
                      </span>
                    ) : (
                      <span className={end.soon ? 'font-semibold text-warn' : ''} data-testid="api-token-end">
                        {end.text}
                      </span>
                    )}
                    {' · '}
                    {token.last_used_at ? t('apiTokens.used', { when: moment(token.last_used_at) }) : t('apiTokens.unused')}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void action.run(async () => {
                    await apiTokensApi.remove(token.id)
                    await load()
                  })}
                  className="rounded-full p-1.5 text-muted hover:bg-sheet hover:text-ink"
                  aria-label={t('apiTokens.deleteNamed', { name: token.name })}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {!making ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setMaking(true)}>
            <Plus size={16} /> {t('apiTokens.new')}
          </Button>
          <span className="text-xs text-muted">{t('apiTokens.readOnly')}</span>
        </div>
      ) : (
        <form
          className="space-y-3 rounded-xl border border-dashed border-line p-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!name.trim()) return
            void action.run(async () => {
              const made = await apiTokensApi.make(name.trim(), days === 'never' ? null : Number(days))
              setShown({ name: made.token.name, secret: made.secret })
              setCopied(null)
              setMaking(false)
              setName('')
              setDays('never')
              await load()
            })
          }}
        >
          <Input label={t('apiTokens.name')} value={name} onChange={setName} maxLength={100} autoFocus placeholder="nexdeck" />
          <div className="text-sm">
            <p className="mb-1 font-semibold">{t('apiTokens.lifetime')}</p>
            <Segment
              label={t('apiTokens.lifetime')}
              value={days}
              onChange={setDays}
              options={LIFETIMES.map((value) => ({ value, label: value === 'never' ? t('apiTokens.lifetimeNever') : t(`apiTokens.lifetimeDays.${value}`) }))}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" primary busy={action.busy} disabled={!name.trim()}>
              {t('apiTokens.make')}
            </Button>
            <Button onClick={() => setMaking(false)}>{t('common.cancel')}</Button>
          </div>
        </form>
      )}
      {!shown && (
        <details className="rounded-xl border border-line px-4 py-2.5 text-sm">
          <summary className="cursor-pointer font-semibold text-ink-2">{t('apiTokens.whatItDoes')}</summary>
          <p className="mt-2 text-xs text-muted">{t('apiTokens.whatItDoesText')}</p>
          <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-ink-2">
            {ROUTES.map((path) => (
              <li key={path}>
                <span className="inline-block w-10 text-muted">GET</span> {path}
              </li>
            ))}
          </ul>
        </details>
      )}
      <Feedback problem={action.problem} />
    </Card>
  )
}
