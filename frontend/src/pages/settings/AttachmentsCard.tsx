/**
 * Settings, Attachments (operator): how large a video and a recording or PDF may be, the storage per person (the
 * setting of the server that photos count against too), whether HEVC videos are offered to be converted, and how the
 * queue of the converting stands. Without ffmpeg on the server the card says so: then there are no videos and no
 * recordings, PDFs and links still work.
 */
import { Paperclip } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, attachmentsApi, type AttachmentSettings } from '../../api/client'
import { clock } from '../../lib/attachments'
import { setLimits } from '../../lib/attachmentUpload'
import { Button, Card, Feedback, Input, Toggle, useAction } from './ui'

/** "3 Minuten 50": how long the last conversion took. */
function took(seconds: number, t: (key: string, values?: Record<string, unknown>) => string): string {
  const whole = Math.max(0, Math.round(seconds))
  const m = Math.floor(whole / 60)
  const s = whole % 60
  if (m === 0) return t('attachments.admin.tookSeconds', { s })
  return t(m === 1 ? 'attachments.admin.tookOneMinute' : 'attachments.admin.tookMinutes', { m, s: String(s).padStart(2, '0') })
}

export function AttachmentsCard() {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<AttachmentSettings | null>(null)
  const [quota, setQuota] = useState<number | null>(null)
  const [video, setVideo] = useState('')
  const [other, setOther] = useState('')
  const [gb, setGb] = useState('')
  const [convert, setConvert] = useState(true)
  const [invalid, setInvalid] = useState(false)
  const { busy, problem, values, done, run } = useAction()
  const [loadProblem, setLoadProblem] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    attachmentsApi.settings().then(
      (found) => {
        if (!alive) return
        setSettings(found)
        setVideo(String(found.video_max_mb))
        setOther(String(found.other_max_mb))
        setConvert(found.convert)
      },
      () => alive && setLoadProblem('internal_error'),
    )
    api<{ storage_per_person_gb: number }>('/api/settings').then(
      (found) => {
        if (!alive || typeof found?.storage_per_person_gb !== 'number') return
        setQuota(found.storage_per_person_gb)
        setGb(String(found.storage_per_person_gb))
      },
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [])

  if (!settings) return loadProblem ? <Feedback problem={loadProblem} /> : null

  const number = (text: string) => Number(text.replace(',', '.'))
  const save = () => {
    const videoMb = Math.round(number(video))
    const otherMb = Math.round(number(other))
    const perPerson = number(gb)
    const ok = videoMb >= 1 && videoMb <= 4000 && otherMb >= 1 && otherMb <= 1000 && (quota === null || (Number.isFinite(perPerson) && perPerson >= 0 && perPerson <= 10000))
    setInvalid(!ok)
    if (!ok) return
    void run(async () => {
      const saved = await attachmentsApi.saveSettings({ video_max_mb: videoMb, other_max_mb: otherMb, convert })
      setSettings(saved)
      setLimits({ video_max_mb: saved.video_max_mb, other_max_mb: saved.other_max_mb, ffmpeg: saved.ffmpeg })
      if (quota !== null && perPerson !== quota) {
        const server = await api<{ storage_per_person_gb: number }>('/api/settings', { method: 'PUT', body: { storage_per_person_gb: perPerson } })
        setQuota(server.storage_per_person_gb)
        setGb(String(server.storage_per_person_gb))
      }
    }, t('settings.saved'))
  }

  const queue = settings.queue
  const running = queue?.running
  const waiting = queue?.waiting ?? 0
  const last = queue?.last
  return (
    <Card id="attachments" icon={Paperclip} title={t('attachments.admin.title')} text={t('attachments.admin.text')}>
      {!settings.ffmpeg && (
        <p role="status" className="rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-ink-2" data-no-ffmpeg>
          {t('attachments.admin.noFfmpeg')}
        </p>
      )}
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Input label={t('attachments.admin.video')} type="number" min={1} max={4000} value={video} onChange={setVideo} hint={t('attachments.admin.mb')} />
          <Input label={t('attachments.admin.other')} type="number" min={1} max={1000} value={other} onChange={setOther} hint={t('attachments.admin.mb')} />
          {quota !== null && <Input label={t('attachments.admin.quota')} type="number" min={0} max={10000} value={gb} onChange={setGb} hint={t('attachments.admin.gb')} />}
        </div>
        <Toggle label={t('attachments.admin.convert')} hint={t('attachments.admin.convertHint')} checked={convert} onChange={setConvert} disabled={!settings.ffmpeg} />
        <div className="rounded-xl bg-sheet-2 px-4 py-3 text-sm text-ink-2" data-queue>
          <span className="font-semibold">{t('attachments.admin.queue')}</span>{' '}
          {running ? t('attachments.admin.queueRunning', { percent: running.progress }) : waiting === 0 ? t('attachments.admin.queueEmpty') : ''}
          {waiting > 0 && ` ${t('attachments.admin.queueWaiting', { count: waiting })}`}
          {last && ` ${t('attachments.admin.last', { length: clock(last.seconds_video), took: took(last.seconds_took, t) })}`}
        </div>
        {invalid && (
          <p role="alert" className="text-sm text-bad">
            {t('attachments.admin.invalid')}
          </p>
        )}
        <Feedback problem={problem} done={done} values={values} />
        <Button type="submit" primary busy={busy}>
          {t('common.save')}
        </Button>
      </form>
    </Card>
  )
}
