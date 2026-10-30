/**
 * The attachments of one day for the reading and the writing page: loaded with the day, changed by the section
 * (`components/Attachments.tsx`), which hands back each change as a function of the list.
 */
import { useCallback, useEffect, useState } from 'react'

import { attachmentsApi, type Attachment } from '../api/client'

export type AttachmentUpdate = (change: (list: Attachment[]) => Attachment[]) => void

/** Adds an attachment to a list, once: the same upload answered twice (a retry) is one attachment. */
export function withAttachment(list: Attachment[], added: Attachment): Attachment[] {
  return list.some((item) => item.id === added.id) ? list.map((item) => (item.id === added.id ? added : item)) : [...list, added]
}

export function useDayAttachments(date: string, enabled = true): { items: Attachment[]; loaded: boolean; update: AttachmentUpdate } {
  const [state, setState] = useState<{ date: string; items: Attachment[] } | null>(null)
  useEffect(() => {
    if (!enabled || !date) return
    let alive = true
    // Never a reason for the day not to show: without them, the page is as it was.
    attachmentsApi.list(date).then(
      (items) => alive && setState({ date, items }),
      () => alive && setState({ date, items: [] }),
    )
    return () => {
      alive = false
    }
  }, [date, enabled])
  const update = useCallback<AttachmentUpdate>((change) => setState((current) => ({ date, items: change(current && current.date === date ? current.items : []) })), [date])
  const mine = state && state.date === date ? state : null
  return { items: mine?.items ?? [], loaded: mine !== null, update }
}
