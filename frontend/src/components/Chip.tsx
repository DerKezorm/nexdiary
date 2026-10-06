import type { ReactNode } from 'react'

/** A round choice, as the mock's tags: filled when chosen. */
export function Chip({ active = false, children, onClick, label }: { active?: boolean; children: ReactNode; onClick?: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`inline-flex h-8 items-center gap-1 rounded-full border px-3 text-sm font-semibold transition ${
        active ? 'border-transparent bg-accent text-accent-ink' : 'border-line bg-sheet text-ink-2 hover:border-accent'
      }`}
    >
      {children}
    </button>
  )
}
