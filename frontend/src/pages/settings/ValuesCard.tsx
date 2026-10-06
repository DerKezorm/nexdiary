/**
 * "My values", as the mock's card: every value with its two ends and a switch whether it is asked, and a field for one
 * of one's own. On top of the mock (the server can do it, the mock only hints): the pencil of a row opens a dialog to
 * rename the value, give it other ends or a hint, move it up or down, or delete it. The row itself stays as quiet as
 * the mock's, and its text wraps on a phone instead of being cut off.
 */
import { ArrowDown, ArrowUp, Pencil, Plus, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { diaryApi, type ValueDef } from '../../api/client'
import { Dialog } from '../../components/Dialog'
import { Button, Card, Confirm, Feedback, Input, useAction } from './ui'

export function ValuesCard() {
  const { t } = useTranslation()
  const [values, setValues] = useState<ValueDef[] | null>(null)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<ValueDef | null>(null)
  const action = useAction()
  const { run } = action

  useEffect(() => {
    void run(async () => setValues(await diaryApi.values()))
  }, [run])

  const switchValue = (value: ValueDef) => {
    setValues((all) => all && all.map((item) => (item.id === value.id ? { ...item, active: !item.active } : item)))
    void run(async () => {
      const changed = await diaryApi.changeValue(value.id, { active: !value.active })
      setValues((all) => all && all.map((item) => (item.id === changed.id ? changed : item)))
    }).then((worked) => worked || void diaryApi.values().then(setValues, () => undefined))
  }

  const move = (id: string, by: -1 | 1) => {
    if (!values) return
    const index = values.findIndex((item) => item.id === id)
    const order = values.map((item) => item.id)
    const target = index + by
    if (target < 0 || target >= order.length) return
    ;[order[index], order[target]] = [order[target], order[index]]
    setValues(order.map((id) => values.find((item) => item.id === id)!))
    void run(async () => setValues(await diaryApi.orderValues(order))).then((worked) => worked || void diaryApi.values().then(setValues, () => undefined))
  }


  return (
    <Card icon={SlidersHorizontal} title={t('settings.values.title')} text={t('settings.values.text')}>
      {values && values.length === 0 && <p className="text-sm text-muted">{t('settings.values.none')}</p>}
      {values && values.length > 0 && (
        <ul className="space-y-2">
          {values.map((value) => (
            <li key={value.id} className="flex items-center gap-3 rounded-xl border border-line bg-sheet-2/50 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1 break-words">
                <span className="font-semibold">{value.unreadable ? t('settings.values.unreadable') : value.name}</span>
                {!value.unreadable && <span className="block text-xs text-muted">{t('settings.values.ends', { low: value.low, high: value.high })}</span>}
              </span>
              <button type="button" className="shrink-0 rounded-full p-1.5 text-muted hover:bg-sheet-2 hover:text-ink" onClick={() => setEditing(value)} aria-label={t('settings.values.edit', { name: value.name })}>
                <Pencil size={15} />
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={value.active}
                aria-label={t('settings.values.ask', { name: value.name })}
                onClick={() => switchValue(value)}
                className={`relative h-7 w-12 shrink-0 rounded-full transition ${value.active ? 'bg-accent' : 'bg-line'}`}
              >
                <span className={`absolute top-1 h-5 w-5 rounded-full bg-sheet shadow transition-all ${value.active ? 'left-6' : 'left-1'}`} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const clean = name.trim()
          if (!clean || action.busy) return
          void run(async () => {
            const made = await diaryApi.addValue({ name: clean, low: t('settings.values.defaultLow'), high: t('settings.values.defaultHigh') })
            setValues((all) => [...(all ?? []), made])
            setName('')
          })
        }}
      >
        <Input label={t('settings.values.own')} value={name} onChange={setName} placeholder={t('settings.values.ownPlaceholder')} maxLength={40} className="min-w-64 flex-1" />
        <Button type="submit" disabled={!name.trim()} busy={action.busy}>
          <Plus size={16} /> {t('settings.values.add')}
        </Button>
      </form>
      <Feedback problem={action.problem} values={action.values} />
      {editing && (
        <EditValue
          value={editing}
          first={values?.[0]?.id === editing.id}
          last={values?.[values.length - 1]?.id === editing.id}
          onMove={(by) => move(editing.id, by)}
          onClose={() => setEditing(null)}
          onSaved={(changed) => {
            setValues((all) => all && all.map((item) => (item.id === changed.id ? changed : item)))
            setEditing(null)
          }}
          onDeleted={(id) => {
            setValues((all) => all && all.filter((item) => item.id !== id))
            setEditing(null)
          }}
        />
      )}
    </Card>
  )
}

function EditValue({ value, first, last, onMove, onClose, onSaved, onDeleted }: {
  value: ValueDef
  first: boolean
  last: boolean
  onMove: (by: -1 | 1) => void
  onClose: () => void
  onSaved: (value: ValueDef) => void
  onDeleted: (id: string) => void
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState({ name: value.name, low: value.low, high: value.high, hint: value.hint })
  const [deleting, setDeleting] = useState(false)
  const action = useAction()
  if (deleting)
    return (
      <Confirm
        title={t('settings.values.deleteTitle')}
        text={t('settings.values.deleteText', { name: value.name })}
        confirm={t('settings.values.delete')}
        danger
        onCancel={() => setDeleting(false)}
        onConfirm={async () => {
          await diaryApi.deleteValue(value.id)
          onDeleted(value.id)
        }}
      />
    )
  return (
    <Dialog title={t('settings.values.editTitle')} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void action.run(async () => onSaved(await diaryApi.changeValue(value.id, form)))
        }}
      >
        <Input label={t('settings.values.name')} value={form.name} onChange={(name) => setForm({ ...form, name })} maxLength={40} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label={t('settings.values.low')} value={form.low} onChange={(low) => setForm({ ...form, low })} maxLength={30} />
          <Input label={t('settings.values.high')} value={form.high} onChange={(high) => setForm({ ...form, high })} maxLength={30} />
        </div>
        <Input label={t('settings.values.hint')} value={form.hint} onChange={(hint) => setForm({ ...form, hint })} placeholder={t('settings.values.hintPlaceholder')} maxLength={80} />
        <div className="flex flex-wrap gap-2">
          <Button small disabled={first} onClick={() => onMove(-1)}>
            <ArrowUp size={14} /> {t('settings.values.moveUp')}
          </Button>
          <Button small disabled={last} onClick={() => onMove(1)}>
            <ArrowDown size={14} /> {t('settings.values.moveDown')}
          </Button>
        </div>
        <Feedback problem={action.problem} values={action.values} />
        <div className="flex flex-wrap justify-between gap-2 pt-1">
          <Button danger onClick={() => setDeleting(true)}>
            {t('settings.values.delete')}
          </Button>
          <div className="flex gap-2">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" primary busy={action.busy} disabled={!form.name.trim()}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
