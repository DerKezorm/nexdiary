import { X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

/** A dialog over the page, as the mock's: from below on a phone, in the middle on a larger screen. Escape and the scrim
 * close it, focus starts inside and comes back afterwards. `above`: over everything, also over the big view of a photo
 * (drawn into the body, outside the page behind, which stands still while that view is open). */
export function Dialog({ title, onClose, children, wide = false, above = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; above?: boolean }) {
  const { t } = useTranslation()
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const first = panel.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])')
    first?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      before?.focus?.()
    }
  }, [onClose])
  const dialog = (
    <div className={`fixed inset-0 ${above ? 'z-[70]' : 'z-50'} flex items-end justify-center bg-scrim p-0 sm:items-center sm:p-6`} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={title} className={`card rise max-h-[92dvh] w-full overflow-auto rounded-b-none p-6 sm:rounded-b-[1.25rem] ${wide ? 'max-w-3xl' : 'max-w-lg'}`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-xl font-semibold">{title}</h2>
          <button type="button" data-close onClick={onClose} className="rounded-full p-2 text-muted hover:bg-sheet-2" aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
  return above ? createPortal(dialog, document.body) : dialog
}
