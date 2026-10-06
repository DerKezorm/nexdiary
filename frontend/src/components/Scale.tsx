import { useTranslation } from 'react-i18next'

/**
 * 1 to 10 as a row of buttons, as the mock's; the number stays readable for whoever does not see the colour. Tapping the
 * chosen number again takes the rating back (the values are voluntary).
 */
export function Scale({ value, onChange, low, high, label }: { value?: number; onChange: (n: number | null) => void; low: string; high: string; label: string }) {
  const { t } = useTranslation()
  return (
    <div role="group" aria-label={label}>
      <div className="flex gap-1">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => {
          const on = value !== undefined && n <= value
          return (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n === value ? null : n)}
              aria-label={t('today.outOfTen', { n })}
              aria-pressed={n === value}
              className={`h-8 flex-1 rounded-lg text-xs font-bold transition ${on ? 'bg-accent text-accent-ink' : 'bg-sheet-2 text-muted hover:bg-accent-soft'} ${
                n === value ? 'ring-2 ring-accent ring-offset-2 ring-offset-sheet' : ''
              }`}
              style={on ? { opacity: 0.45 + (n / 10) * 0.55 } : undefined}
            >
              {n}
            </button>
          )
        })}
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  )
}
