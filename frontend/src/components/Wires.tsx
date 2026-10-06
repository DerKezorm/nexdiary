// Small sketches of the layouts of "Today", for choosing one under Settings, Look. As the mock's.
import type { Layout } from '../api/client'

const bar = 'rounded bg-line'

export function LayoutWire({ kind }: { kind: Layout }) {
  if (kind === 'chat')
    return (
      <div className="mx-auto w-32 space-y-1.5 rounded-xl border border-line bg-paper p-2" aria-hidden="true">
        <div className="h-2 w-14 rounded bg-ink/30" />
        <div className="h-5 rounded-md bg-accent-soft" />
        {[70, 55, 80].map((w, i) => (
          <div key={i} className="flex justify-end">
            <div className="h-4 rounded-md rounded-br-sm bg-accent/30" style={{ width: `${w}%` }} />
          </div>
        ))}
        <div className="flex h-5 items-center justify-end rounded-full border border-line bg-sheet px-0.5">
          <span className="h-3.5 w-3.5 rounded-full bg-accent" />
        </div>
      </div>
    )
  if (kind === 'columns')
    return (
      <div className="grid grid-cols-[1.4fr_1fr] gap-1.5 rounded-xl border border-line bg-paper p-2" aria-hidden="true">
        <div className="space-y-1.5">
          <div className="h-2 w-14 rounded bg-ink/30" />
          <div className="h-5 rounded-md border border-line bg-sheet" />
          <div className="space-y-1 rounded-md border border-line bg-sheet p-1.5">
            {[90, 70, 85].map((w, i) => (
              <div key={i} className={`h-1.5 ${bar}`} style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
        <div className="space-y-1.5 pt-3.5">
          <div className="h-6 rounded-md bg-accent" />
          <div className="h-7 rounded-md border border-line bg-sheet" />
          <div className="h-5 rounded-md border border-line bg-sheet" />
        </div>
      </div>
    )
  return (
    <div className="mx-auto w-32 space-y-1.5 rounded-xl border border-line bg-paper p-2" aria-hidden="true">
      <div className="h-2 w-14 rounded bg-ink/30" />
      <div className="h-5 rounded-md border border-line bg-sheet" />
      <div className="space-y-1 rounded-md border border-line bg-sheet p-1.5">
        {[90, 70, 85].map((w, i) => (
          <div key={i} className={`h-1.5 ${bar}`} style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-4 flex-1 rounded bg-accent/25" />
        ))}
      </div>
      <div className="h-5 rounded-md bg-accent" />
    </div>
  )
}
