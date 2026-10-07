// Small sketches of the layouts of "Today" and of the journal, for choosing one under My account, Look. As the mock's;
// where the mock draws its photo scenes, the illustrations of the covers stand in.
import type { JournalLook, Layout } from '../api/client'
import { Illustration } from '../covers/drawings'

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

export function JournalWire({ kind }: { kind: JournalLook }) {
  if (kind === 'blog')
    return (
      <div className="space-y-1.5 rounded-xl border border-line bg-paper p-2" aria-hidden="true">
        <div className="grid grid-cols-[1.2fr_1fr] gap-1.5 rounded-md border border-line bg-sheet p-1">
          <Illustration id="berge.tag.sommer" className="h-10 w-full rounded" />
          <div className="space-y-1 py-1">
            <div className="h-2 w-4/5 rounded bg-ink/30" />
            <div className={`h-1.5 ${bar}`} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {['baum.tag.herbst', 'wald.tag.sommer', 'regen.tag.herbst'].map((id) => (
            <div key={id} className="rounded-md border border-line bg-sheet p-0.5">
              <Illustration id={id} className="h-6 w-full rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  return (
    <div className="space-y-1 rounded-xl border border-line bg-paper p-2" aria-hidden="true">
      <div className="divide-y divide-line rounded-md border border-line bg-sheet">
        {['berge.tag.sommer', 'regen.tag.herbst', 'wald.tag.sommer', 'feld.tag.sommer'].map((id, i) => (
          <div key={id} className="flex items-center gap-1.5 p-1">
            <span className="w-3 text-center font-display text-[0.6rem] font-bold text-accent">{5 - i}</span>
            <div className="flex-1 space-y-0.5">
              <div className="h-1.5 w-3/5 rounded bg-ink/25" />
              <div className={`h-1 ${bar}`} />
            </div>
            <Illustration id={id} className="h-4 w-6 rounded-sm" />
          </div>
        ))}
      </div>
    </div>
  )
}
