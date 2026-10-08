/**
 * "Vorlagen", the card under My account, Writing: fixed headings for a page, each with a question as a hint. The AI fills
 * them when it writes a page up (only what the notes say, the rest stays empty); when writing by hand they stand in the
 * text. One of them can be the default.
 *
 * The list is kept whole on the server (sealed like the diary) and replaced as a whole, onto the revision it was read at:
 * a list changed on another device meanwhile is refused, read again, and said so (`templates_changed`), never
 * overwritten unseen. Two examples are offered while there is no template; taking one copies it.
 */
import { ArrowDown, ArrowUp, LayoutTemplate, Pencil, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, templatesApi, type Template, type TemplateIn, type TemplateSection, type TemplateSet } from '../../api/client'
import { Dialog } from '../../components/Dialog'
import { Button, Card, Confirm, Feedback, Input, Select, SubHead, useAction } from './ui'

/** At most as the server takes. */
const MAX_SECTIONS = 12
const NAME_MAX = 60
const HEADING_MAX = 120
const QUESTION_MAX = 300
/** The examples: their texts are in the language files as `settings.templates.<name>`. */
const EXAMPLES = ['review', 'work'] as const

const NONE = ''

export function TemplatesCard() {
  const { t } = useTranslation()
  const [set, setSet] = useState<TemplateSet | null>(null)
  const [editing, setEditing] = useState<Template | 'new' | null>(null)
  const action = useAction()
  const { run } = action

  useEffect(() => {
    void run(async () => setSet(await templatesApi.get()))
  }, [run])

  /** Saves the whole list onto the revision that was read. A list changed elsewhere meanwhile is read again (and the
   * refusal is shown); everything else is left to the caller's own feedback. */
  const persist = useCallback(
    async (templates: TemplateIn[], defaultId: string | null): Promise<TemplateSet> => {
      const revision = set?.revision ?? -1
      try {
        const saved = await templatesApi.save(templates, defaultId, revision)
        setSet(saved)
        return saved
      } catch (error) {
        if (error instanceof ApiError && (error.code === 'templates_changed' || error.code === 'template_unknown')) {
          await templatesApi.get().then(setSet, () => undefined)
        }
        throw error
      }
    },
    [set],
  )

  if (!set) return <Card icon={LayoutTemplate} title={t('settings.templates.title')} text={t('settings.templates.text')}><Feedback problem={action.problem} values={action.values} /></Card>

  const stored = (): TemplateIn[] => set.templates.map((template) => ({ id: template.id, name: template.name, sections: template.sections }))
  const take = (name: (typeof EXAMPLES)[number]) =>
    run(async () => {
      const sections: TemplateSection[] = [1, 2, 3, 4].map((number) => ({
        heading: t(`settings.templates.${name}.heading${number}`),
        question: t(`settings.templates.${name}.question${number}`),
      }))
      await persist([...stored(), { name: t(`settings.templates.${name}.name`), sections }], set.default)
    })
  const changeDefault = (id: string) => run(async () => void (await persist(stored(), id === NONE ? null : id)))

  return (
    <Card icon={LayoutTemplate} title={t('settings.templates.title')} text={t('settings.templates.text')} id="templates">
      {set.templates.length === 0 ? (
        <>
          <p className="text-sm text-muted">{t('settings.templates.none')}</p>
          <SubHead title={t('settings.templates.examples')} text={t('settings.templates.examplesText')} />
          <ul className="grid gap-2 sm:grid-cols-2">
            {EXAMPLES.map((name) => (
              <li key={name} className="rounded-xl border border-line bg-sheet-2/50 p-4 text-sm">
                <span className="font-semibold">{t(`settings.templates.${name}.name`)}</span>
                <span className="mt-1 block text-xs text-muted">
                  {[1, 2, 3, 4].map((number) => t(`settings.templates.${name}.heading${number}`)).join(', ')}
                </span>
                <Button small className="mt-3" busy={action.busy} label={t('settings.templates.useExample', { name: t(`settings.templates.${name}.name`) })} onClick={() => void take(name)}>
                  {t('settings.templates.use')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <ul className="space-y-2">
          {set.templates.map((template) => (
            <li key={template.id} className="flex items-center gap-3 rounded-xl border border-line bg-sheet-2/50 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1 break-words">
                <span className="font-semibold">{template.name}</span>
                <span className="block text-xs text-muted">{t('settings.templates.sections', { count: template.sections.length })}</span>
              </span>
              <button type="button" className="shrink-0 rounded-full p-1.5 text-muted hover:bg-sheet-2 hover:text-ink" onClick={() => setEditing(template)} aria-label={t('settings.templates.edit', { name: template.name })}>
                <Pencil size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button onClick={() => setEditing('new')} disabled={set.templates.length >= 20}>
          <Plus size={16} aria-hidden /> {t('settings.templates.new')}
        </Button>
      </div>
      {set.templates.length > 0 && (
        <Select
          label={t('settings.templates.default')}
          value={set.default ?? NONE}
          options={[{ value: NONE, label: t('settings.templates.defaultNone') }, ...set.templates.map((template) => ({ value: template.id, label: template.name }))]}
          onChange={(id) => void changeDefault(id)}
          className="max-w-sm"
        />
      )}
      {set.templates.length > 0 && <p className="text-xs text-muted">{t('settings.templates.defaultHint')}</p>}
      <Feedback problem={action.problem} values={action.values} />
      {editing && (
        <EditTemplate
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            // A template that is gone elsewhere is sent with its id all the same: the server says so (`template_unknown`).
            const known = stored().some((entry) => entry.id === draft.id)
            const list = known ? stored().map((entry) => (entry.id === draft.id ? draft : entry)) : [...stored(), draft]
            await persist(list, set.default)
            setEditing(null)
          }}
          onDelete={async (id) => {
            const list = stored().filter((entry) => entry.id !== id)
            await persist(list, set.default === id ? null : set.default)
            setEditing(null)
          }}
        />
      )}
    </Card>
  )
}

/** A section while it is edited: the key keeps its fields together when sections move. */
type Draft = TemplateSection & { key: number }

function EditTemplate({ template, onClose, onSave, onDelete }: {
  template: Template | null
  onClose: () => void
  onSave: (draft: TemplateIn) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const keys = useRef(0)
  const next = () => ++keys.current
  const [name, setName] = useState(template?.name ?? '')
  const [sections, setSections] = useState<Draft[]>(() => (template ? template.sections.map((section) => ({ ...section, key: next() })) : [{ heading: '', question: '', key: next() }]))
  const [deleting, setDeleting] = useState(false)
  const action = useAction()

  const change = (key: number, part: Partial<TemplateSection>) => setSections((all) => all.map((section) => (section.key === key ? { ...section, ...part } : section)))
  const move = (index: number, by: -1 | 1) =>
    setSections((all) => {
      const target = index + by
      if (target < 0 || target >= all.length) return all
      const out = [...all]
      ;[out[index], out[target]] = [out[target], out[index]]
      return out
    })

  if (deleting && template)
    return (
      <Confirm
        title={t('settings.templates.deleteTitle')}
        text={t('settings.templates.deleteText', { name: template.name })}
        confirm={t('settings.templates.delete')}
        danger
        onCancel={() => setDeleting(false)}
        onConfirm={() => onDelete(template.id)}
      />
    )

  const ready = name.trim() !== '' && sections.length > 0 && sections.every((section) => section.heading.trim() !== '')
  return (
    <Dialog title={template ? t('settings.templates.editTitle') : t('settings.templates.newTitle')} onClose={onClose} wide>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (!ready) return
          void action.run(() =>
            onSave({
              ...(template ? { id: template.id } : {}),
              name: name.trim(),
              sections: sections.map((section) => ({ heading: section.heading.trim(), question: section.question.trim() })),
            }),
          )
        }}
      >
        <Input label={t('settings.templates.name')} value={name} onChange={setName} placeholder={t('settings.templates.namePlaceholder')} maxLength={NAME_MAX} autoFocus />
        <SubHead title={t('settings.templates.sectionsTitle')} />
        <ol className="space-y-3">
          {sections.map((section, index) => {
            const number = index + 1
            return (
              <li key={section.key} className="rounded-xl border border-line bg-sheet-2/50 p-3" aria-label={t('settings.templates.sectionNumber', { number })}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-bold tracking-wide text-muted uppercase">{t('settings.templates.sectionNumber', { number })}</span>
                  <span className="flex gap-1">
                    <button type="button" disabled={index === 0} onClick={() => move(index, -1)} className="rounded-full p-1.5 text-muted hover:bg-sheet-2 hover:text-ink disabled:opacity-40" aria-label={t('settings.templates.moveUp', { number })}>
                      <ArrowUp size={15} />
                    </button>
                    <button type="button" disabled={index === sections.length - 1} onClick={() => move(index, 1)} className="rounded-full p-1.5 text-muted hover:bg-sheet-2 hover:text-ink disabled:opacity-40" aria-label={t('settings.templates.moveDown', { number })}>
                      <ArrowDown size={15} />
                    </button>
                    <button type="button" disabled={sections.length <= 1} onClick={() => setSections((all) => all.filter((item) => item.key !== section.key))} className="rounded-full p-1.5 text-muted hover:bg-sheet-2 hover:text-ink disabled:opacity-40" aria-label={t('settings.templates.removeSection', { number })}>
                      <X size={15} />
                    </button>
                  </span>
                </div>
                <div className="space-y-2">
                  <Input label={t('settings.templates.heading')} value={section.heading} onChange={(heading) => change(section.key, { heading })} placeholder={t('settings.templates.headingPlaceholder')} maxLength={HEADING_MAX} />
                  <Input label={t('settings.templates.question')} value={section.question} onChange={(question) => change(section.key, { question })} placeholder={t('settings.templates.questionPlaceholder')} maxLength={QUESTION_MAX} />
                </div>
              </li>
            )
          })}
        </ol>
        <Button disabled={sections.length >= MAX_SECTIONS} onClick={() => setSections((all) => [...all, { heading: '', question: '', key: next() }])}>
          <Plus size={16} aria-hidden /> {t('settings.templates.addSection')}
        </Button>
        <Feedback problem={action.problem} values={action.values} />
        <div className="flex flex-wrap justify-between gap-2 pt-1">
          {template ? (
            <Button danger onClick={() => setDeleting(true)}>
              {t('settings.templates.delete')}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" primary busy={action.busy} disabled={!ready}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
