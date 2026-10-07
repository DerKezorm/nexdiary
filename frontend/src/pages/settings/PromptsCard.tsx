/**
 * "Schreibimpulse", as the mock's card under My account, Writing: questions on or off, the six groups each on or off,
 * and questions of one's own. Kept with the account (sealed on the server like the diary), so every device asks the
 * same; the question of the day on "Today" and the questions while writing come from here.
 *
 * Every change is a single one (this group on, that question gone), made by the server on what stands there: a tab
 * open since the morning never puts back what another tab changed meanwhile. The card shows what the server answers.
 */
import { Check, MessageCircleQuestion, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { promptsApi, type PromptChoice } from '../../api/client'
import { Button, Card, Feedback, Input, SubHead, Toggle, useAction } from './ui'

export function PromptsCard() {
  const { t } = useTranslation()
  const [choice, setChoice] = useState<PromptChoice | null>(null)
  const [own, setOwn] = useState('')
  const action = useAction()
  useEffect(() => {
    let alive = true
    promptsApi.choice().then((found) => alive && setChoice(found), () => undefined)
    return () => {
      alive = false
    }
  }, [])
  if (!choice) return null

  /** Shows the change at once; the server's answer (the whole choice as it stands now) replaces it, a refusal puts
   * the card back. */
  const change = (shown: PromptChoice, send: () => Promise<PromptChoice>) => {
    const before = choice
    setChoice(shown)
    void action.run(async () => setChoice(await send())).then((worked) => worked || setChoice(before))
  }
  const toggleSet = (id: string, on: boolean) =>
    change({ ...choice, sets: choice.sets.map((entry) => (entry.id === id ? { ...entry, on } : entry)) }, () => promptsApi.switchSet(id, on))

  return (
    <Card icon={MessageCircleQuestion} title={t('settings.prompts.title')} text={t('settings.prompts.text')}>
      <Toggle label={t('settings.prompts.show')} hint={t('settings.prompts.showHint')} checked={choice.on} onChange={(on) => change({ ...choice, on }, () => promptsApi.switch(on))} />
      {choice.on && (
        <>
          <SubHead title={t('settings.prompts.which')} text={t('settings.prompts.whichText')} />
          <div className="grid gap-2 sm:grid-cols-2">
            {choice.sets.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => toggleSet(entry.id, !entry.on)}
                aria-pressed={entry.on}
                className={`rounded-xl border px-4 py-3 text-left text-sm transition ${entry.on ? 'border-accent bg-accent-soft/50' : 'border-line hover:bg-sheet-2'}`}
              >
                <span className="flex items-center justify-between">
                  <span className="font-semibold">{entry.name}</span>
                  <span className={`flex h-5 w-5 items-center justify-center rounded-full ${entry.on ? 'bg-accent text-accent-ink' : 'border-2 border-line'}`}>
                    {entry.on && <Check size={12} strokeWidth={3} aria-hidden />}
                  </span>
                </span>
                <span className="mt-1 block text-xs text-muted">{t('settings.prompts.more', { first: entry.questions[0], count: entry.questions.length - 1 })}</span>
              </button>
            ))}
          </div>
          <SubHead title={t('settings.prompts.own')} text={t('settings.prompts.ownText')} />
          {choice.own.length > 0 && (
            <ul className="space-y-2">
              {choice.own.map((question) => (
                <li key={question.id} className="flex items-center gap-3 rounded-xl border border-line bg-sheet-2/50 px-4 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 break-words">{question.text}</span>
                  <button
                    type="button"
                    onClick={() => change({ ...choice, own: choice.own.filter((item) => item.id !== question.id) }, () => promptsApi.removeOwn(question.id))}
                    className="rounded-full p-1 text-muted hover:text-ink"
                    aria-label={`${t('settings.prompts.remove')}: ${question.text}`}
                  >
                    <X size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const question = own.trim()
              if (question) change({ ...choice, own: [...choice.own, { id: `new-${question}`, text: question }] }, () => promptsApi.addOwn(question))
              setOwn('')
            }}
          >
            <Input label={t('settings.prompts.new')} value={own} onChange={setOwn} placeholder={t('settings.prompts.newPlaceholder')} maxLength={300} className="min-w-64 flex-1" />
            <Button type="submit">
              <Plus size={16} aria-hidden /> {t('settings.prompts.add')}
            </Button>
          </form>
        </>
      )}
      <Feedback problem={action.problem} values={action.values} />
    </Card>
  )
}
