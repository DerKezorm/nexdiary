/**
 * Immich, as the mock's card under My account, Connections: each person connects their own Immich (address and API key; the
 * key is typed once and never shown again), switches the photos of the day on or off, saves and checks, disconnects.
 * While the operator has not allowed Immich, the card says only that.
 *
 * The operator's own card (Settings, Immich) holds the bolt: Immich off from the start, and the hosts it may
 * be reached on, one per line. It says how many people connected, never whose Immich it is.
 */
import { Check, Image } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { immichApi, type ImmichSettings, type ImmichState } from '../../api/client'
import { Button, Card, Feedback, Input, Toggle, useAction } from './ui'

export function ImmichCard() {
  const { t } = useTranslation()
  const [state, setState] = useState<ImmichState | null>(null)
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [suggest, setSuggest] = useState(true)
  const action = useAction()
  const [probed, setProbed] = useState<string | null>(null)

  const take = (found: ImmichState) => {
    setState(found)
    setUrl(found.url ?? '')
    setSuggest(found.suggest ?? true)
    setKey('')
  }
  useEffect(() => {
    let alive = true
    immichApi.state().then((found) => alive && take(found), () => undefined)
    return () => {
      alive = false
    }
  }, [])
  if (!state) return null
  if (!state.allowed)
    return (
      <Card id="immich" icon={Image} title={t('settings.immich.title')}>
        <p className="text-sm text-ink-2">{t('settings.immich.closed')}</p>
      </Card>
    )

  /** Saves what is typed, then asks the own Immich whether it answers with the key. */
  const saveAndCheck = () => {
    setProbed(null)
    void action.run(async () => {
      const change: Parameters<typeof immichApi.save>[0] = { url: url.trim(), suggest }
      if (key.trim()) change.key = key.trim()
      take(await immichApi.save(change))
      const probe = await immichApi.probe()
      setProbed(
        probe.more
          ? t('settings.immich.probedMore', { version: probe.version, count: probe.today })
          : t('settings.immich.probed', { version: probe.version, count: probe.today }),
      )
      take(await immichApi.state())
    })
  }

  const switchSuggest = (on: boolean) => {
    setSuggest(on)
    if (!state.connected) return
    setProbed(null)
    void action.run(async () => take(await immichApi.save({ suggest: on }))).then((worked) => worked || setSuggest(!on))
  }

  const disconnect = () => {
    setProbed(null)
    void action.run(async () => {
      await immichApi.disconnect()
      take(await immichApi.state())
    }, t('settings.immich.disconnected'))
  }

  return (
    <Card id="immich" icon={Image} title={t('settings.immich.title')} text={t('settings.immich.text')}>
      {state.connected && (
        <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-sm font-semibold text-accent">
          <Check size={14} aria-hidden /> {state.email ? t('settings.immich.connectedAs', { email: state.email }) : t('settings.immich.connected')}
        </div>
      )}
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault()
          saveAndCheck()
        }}
      >
        <Input label={t('settings.immich.url')} value={url} onChange={setUrl} placeholder="https://photos.example.com" maxLength={255} />
        <Input
          label={t('settings.immich.key')}
          type="password"
          autoComplete="new-password"
          value={key}
          onChange={setKey}
          maxLength={200}
          placeholder={state.key_set ? t('settings.immich.keyKept') : ''}
          hint={t('settings.immich.keyHint')}
        />
        <div className="sm:col-span-2">
          <Toggle label={t('settings.immich.suggest')} hint={t('settings.immich.suggestHint')} checked={suggest} onChange={switchSuggest} />
        </div>
        <div className="flex gap-2 sm:col-span-2">
          <Button primary type="submit" busy={action.busy} disabled={!url.trim() || (!key.trim() && !state.key_set)}>
            {t('settings.immich.save')}
          </Button>
          {state.connected && (
            <Button danger onClick={disconnect} disabled={action.busy}>
              {t('settings.immich.disconnect')}
            </Button>
          )}
        </div>
      </form>
      <Feedback problem={action.problem} values={action.values} done={probed ?? action.done} />
    </Card>
  )
}

const AREA = 'mt-1 block min-h-28 w-full rounded-xl border border-line bg-sheet px-3.5 py-2.5 font-mono text-[0.9rem] text-ink outline-none placeholder:text-muted/70 focus:border-accent'

export function ImmichServerCard() {
  const { t } = useTranslation()
  const [stored, setStored] = useState<ImmichSettings | null>(null)
  const [hosts, setHosts] = useState('')
  const action = useAction()
  const hintId = useId()

  const take = (found: ImmichSettings) => {
    setStored(found)
    setHosts(found.hosts.join('\n'))
  }
  useEffect(() => {
    let alive = true
    immichApi.settings().then((found) => alive && take(found), () => undefined)
    return () => {
      alive = false
    }
  }, [])
  if (!stored) return null

  const lines = () => hosts.split('\n').map((line) => line.trim()).filter(Boolean)

  return (
    <Card id="immich-server" icon={Image} title={t('server.immich.title')} text={t('server.immich.text')}>
      <Toggle
        label={t('server.immich.allowed')}
        hint={t('server.immich.allowedHint')}
        checked={stored.allowed}
        onChange={(allowed) => void action.run(async () => take(await immichApi.saveSettings({ allowed })), t('server.immich.saved'))}
      />
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          void action.run(async () => take(await immichApi.saveSettings({ hosts: lines() })), t('server.immich.saved'))
        }}
      >
        <div className="text-sm">
          <label className="block">
            <span className="font-semibold">{t('server.immich.hosts')}</span>
            <textarea
              value={hosts}
              onChange={(event) => setHosts(event.target.value)}
              rows={4}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              maxLength={13000}
              placeholder="photos.example.com"
              aria-describedby={hintId}
              className={AREA}
            />
          </label>
          <span id={hintId} className="mt-1 block text-xs text-muted">
            {t('server.immich.hostsHint')}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button primary type="submit" busy={action.busy}>
            {t('server.immich.save')}
          </Button>
          <span className="text-sm text-muted">{t('server.immich.connected', { count: stored.connected })}</span>
        </div>
      </form>
      <Feedback problem={action.problem} values={action.values} done={action.done} />
    </Card>
  )
}
