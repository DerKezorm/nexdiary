/**
 * The tooltip of a chart: drawn into the body with `position: fixed`, so no scrolling card can cut it off or grow a
 * scroll bar for it. `anchor` is what it points at, in window coordinates; it stands over it, or under it where there
 * is no room, is kept inside the window, and wraps long words. It goes away when the page or the window moves under it.
 */
import { useLayoutEffect, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { placeTip, type Box } from '../lib/tip'

export function ChartTip({ anchor, onDismiss, children }: { anchor: Box; onDismiss: () => void; children: ReactNode }) {
  const node = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)

  // Placed once its own size is known: invisible for the first paint, never seen in a wrong place.
  useLayoutEffect(() => {
    const element = node.current
    if (!element) return
    const size = element.getBoundingClientRect()
    const { left, top } = placeTip(anchor, { width: size.width, height: size.height }, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight })
    setAt({ left, top })
  }, [anchor, children])

  useEffect(() => {
    // Scrolling (of the page or of the card) and resizing move what it points at.
    window.addEventListener('scroll', onDismiss, true)
    window.addEventListener('resize', onDismiss)
    return () => {
      window.removeEventListener('scroll', onDismiss, true)
      window.removeEventListener('resize', onDismiss)
    }
  }, [onDismiss])

  return createPortal(
    <div
      ref={node}
      role="status"
      data-chart-tip
      className="pointer-events-none fixed z-50 w-max max-w-[min(16rem,calc(100vw-1rem))] rounded-lg bg-ink px-3 py-1.5 text-xs break-words text-paper shadow-soft"
      style={{ left: at?.left ?? 0, top: at?.top ?? 0, visibility: at ? 'visible' : 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  )
}
