/**
 * What is personal, as cards for "My account": the language, the colour and light or dark, where a phone starts, the
 * layout of "Today" and of the journal, and the writing goal. Each is kept with the account (never only in this
 * browser).
 */
import { Database, Globe, ListChecks, Palette, Smartphone, Target } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { authApi, type JournalLook, type Layout, type Me, type Profile } from '../../api/client'
import { JournalWire, LayoutWire } from '../../components/Wires'
import { changeLanguage, languageOptions, type LanguageOption } from '../../i18n'
import { applyMode, applyPalette, isPalette, PALETTES, storedMode, storedPalette, type Mode, type Palette as PaletteId } from '../../lib/theme'
import { useAuth } from '../../state/auth'
import { Card, Feedback, Segment, Toggle, useAction } from './ui'

export function LanguageCard() {
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

/** The accent colour as five pictures of the same page, and light, dark or as the system; both kept with the account. */
export function LooksCard() {
  const { t } = useTranslation()
  const { me, setMe } = useAuth()
  const [mode, setMode] = useState<Mode>(me?.profile.mode ?? storedMode())
  const [palette, setPalette] = useState<PaletteId>(isPalette(me?.profile.palette) ? me.profile.palette : storedPalette())
  const action = useAction()
  const save = (change: Partial<Profile>) => {
    void action.run(async () => {
      const profile = await authApi.preferences(change)
      if (me) setMe({ ...me, profile } as Me)
    })
  }
  return (
    <Card icon={Palette} title={t('settings.looks.title')} text={t('settings.looks.text')}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PALETTES.map((id) => {
          const on = palette === id
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => {
                applyPalette(id)
                setPalette(id)
                save({ palette: id })
              }}
              className={`overflow-hidden rounded-2xl border text-left transition ${on ? 'border-accent ring-2 ring-accent' : 'border-line hover:border-accent/50'}`}
            >
              <span className="grid grid-cols-2">
                <Swatch mode="light" palette={id} />
                <Swatch mode="dark" palette={id} />
              </span>
              <span className="block border-t border-line px-4 py-3">
                <span className="flex items-center justify-between font-semibold">
                  {t(`settings.looks.palette.${id}.name`)}
                  {id === 'salbei' && <span className="text-xs font-normal text-muted">{t('settings.looks.own')}</span>}
                </span>
                <span className="mt-0.5 block text-xs text-muted">{t(`settings.looks.palette.${id}.mood`)}</span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="mt-6 mb-3">
        <h3 className="font-semibold">{t('settings.looks.modeTitle')}</h3>
      </div>
      <Segment
        label={t('theme.group')}
        value={mode}
        onChange={(value) => {
          applyMode(value)
          setMode(value)
          save({ mode: value })
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

/** One small page in the paper and the accent of a palette, light or dark, whatever the page itself shows now. */
function Swatch({ mode, palette }: { mode: 'light' | 'dark'; palette: PaletteId }) {
  const { t } = useTranslation()
  return (
    <span data-swatch={mode} data-palette={palette} className="swatch block space-y-2 bg-paper p-3 text-ink">
      <span className="block font-display text-sm font-semibold">{t('settings.looks.swatchTitle')}</span>
      <span className="block rounded-lg border border-line bg-sheet px-2 py-1.5 font-serif text-[0.65rem] leading-snug text-ink-2">{t('settings.looks.swatchNote')}</span>
      <span className="flex gap-0.5">
        {[1, 2, 3, 4, 5, 6, 7].map((n) => (
          <span key={n} className={`h-2 flex-1 rounded-sm ${n <= 5 ? 'bg-accent' : 'bg-sheet-2'}`} style={n <= 5 ? { opacity: 0.4 + n * 0.12 } : undefined} />
        ))}
      </span>
      <span className="block rounded-full bg-accent py-1 text-center text-[0.6rem] font-bold text-accent-ink">{t('settings.looks.swatchButton')}</span>
    </span>
  )
}

/** Saves a profile choice with the account (never only in this browser) and shows it at once. */
function useProfileChoice() {
  const { me, setMe } = useAuth()
  const action = useAction()
  const choose = (change: Partial<Profile>) => {
    if (!me) return
    setMe({ ...me, profile: { ...me.profile, ...change } })
    void action.run(async () => {
      const profile = await authApi.preferences(change)
      setMe({ ...me, profile })
    }).then((worked) => worked || void authApi.me().then(setMe, () => undefined))
  }
  return { profile: me?.profile, choose, problem: action.problem }
}

/** How many pages a week the person wants to write, 1 to 7: a slider that is kept when it is let go. What it means for
 * the streak, the shields and the reminder is said below it. */
export function GoalCard() {
  const { t } = useTranslation()
  const { profile, choose, problem } = useProfileChoice()
  const stored = profile?.goal ?? 7
  const [goal, setGoal] = useState(stored)
  const id = useId()
  useEffect(() => setGoal(stored), [stored])
  const keep = () => {
    if (goal !== stored) choose({ goal })
  }
  const said = goal === 7 ? t('settings.goal.daily', { count: goal }) : t('settings.goal.perWeek', { count: goal })
  return (
    <Card icon={Target} title={t('settings.goal.title')} text={t('settings.goal.text')}>
      <label htmlFor={id} className="text-sm font-semibold">
        {t('settings.goal.label')}
      </label>
      <input
        id={id}
        type="range"
        min={1}
        max={7}
        step={1}
        value={goal}
        aria-valuetext={said}
        onChange={(event) => setGoal(Number(event.target.value))}
        onPointerUp={keep}
        onKeyUp={keep}
        onBlur={keep}
        className="block w-full accent-accent"
      />
      <div className="flex justify-between px-1 text-xs text-muted" aria-hidden>
        {[1, 2, 3, 4, 5, 6, 7].map((n) => (
          <span key={n}>{n}</span>
        ))}
      </div>
      <p className="font-display text-xl font-semibold" data-testid="goal-said">
        {said}
      </p>
      <p className="text-sm text-ink-2">{goal === 7 ? t('settings.goal.hintDays') : t('settings.goal.hintWeeks')}</p>
      <p className="text-sm text-ink-2">{t('settings.goal.hintLong')}</p>
      <p className="text-xs text-muted">{t('settings.goal.hintChange')}</p>
      <Feedback problem={problem} />
    </Card>
  )
}

/** Where a phone starts: on the quick note, or in the whole app. */
export function PhoneCard() {
  const { t } = useTranslation()
  const { profile, choose, problem } = useProfileChoice()
  return (
    <Card icon={Smartphone} title={t('settings.phone.title')} text={t('settings.phone.text')}>
      <Toggle label={t('settings.phone.quickStart')} hint={t('settings.phone.quickStartHint')} checked={profile?.quick_start ?? true} onChange={(quick_start) => choose({ quick_start })} />
      <p className="mt-3 text-xs text-muted">{t('settings.phone.also')}</p>
      <Feedback problem={problem} />
    </Card>
  )
}

const LAYOUTS: Layout[] = ['page', 'columns', 'chat']

/** The layout of "Today", chosen from three sketches. */
export function LayoutCard() {
  const { t } = useTranslation()
  const { profile, choose, problem } = useProfileChoice()
  return (
    <Card icon={ListChecks} title={t('settings.layout.title')} text={t('settings.layout.text')}>
      <div className="grid gap-3 sm:grid-cols-3">
        {LAYOUTS.map((layout) => (
          <Choice key={layout} on={(profile?.layout ?? 'page') === layout} onClick={() => choose({ layout })} title={t(`settings.layout.${layout}.name`)} text={t(`settings.layout.${layout}.idea`)}>
            <LayoutWire kind={layout} />
          </Choice>
        ))}
      </div>
      <Feedback problem={problem} />
    </Card>
  )
}

const JOURNALS: JournalLook[] = ['blog', 'timeline']

/** How the journal shows the days: as a blog or as a timeline. */
export function JournalCard() {
  const { t } = useTranslation()
  const { profile, choose, problem } = useProfileChoice()
  return (
    <Card icon={Database} title={t('settings.journal.title')} text={t('settings.journal.text')}>
      <div className="grid gap-3 sm:grid-cols-2">
        {JOURNALS.map((journal) => (
          <Choice key={journal} on={(profile?.journal ?? 'blog') === journal} onClick={() => choose({ journal })} title={t(`settings.journal.${journal}.name`)} text={t(`settings.journal.${journal}.idea`)}>
            <JournalWire kind={journal} />
          </Choice>
        ))}
      </div>
      <Feedback problem={problem} />
    </Card>
  )
}

function Choice({ on, onClick, title, text, children }: { on: boolean; onClick: () => void; title: string; text: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} className={`overflow-hidden rounded-2xl border text-left transition ${on ? 'border-accent ring-2 ring-accent' : 'border-line hover:border-accent/50'}`}>
      <span className="block bg-sheet-2/60 px-5 py-5">{children}</span>
      <span className="block border-t border-line px-4 py-3">
        <span className="font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted">{text}</span>
      </span>
    </button>
  )
}
