/**
 * A note written in the writing view, kept on the day being written and not on today: a day added afterwards gets a
 * few words first, and the AI writes the page from them as from any other notes. Enter adds it, Shift+Enter makes a
 * new line. The same note sent twice (a double click, a retry) keeps one on the server.
 */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError, diaryApi, type Note } from '../api/client'
import { errorText } from '../lib/errors'
import { newId } from '../lib/ids'
import { cleanNote } from '../state/today'

export function AddNote({ date, disabled = false, onAdded }: { date: string; disabled?: boolean; onAdded: (note: Note) => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const id = useRef(newId())
  /** The text the id was last sent with: another text after a failed send is a note of its own. */
  const sentWith = useRef<string | null>(null)
  const sending = useRef(false)
  const clean = cleanNote(text)

  const add = async () => {
    if (!clean || disabled || sending.current) return
    sending.current = true
    setBusy(true)
    try {
      if (sentWith.current !== null && sentWith.current !== clean) id.current = newId()
      sentWith.current = clean
      let note: Note
      try {
        note = await diaryApi.addNote(id.current, clean, date)
      } catch (error) {
        // The id holds another text already: this text is a note of its own.
        if (!(error instanceof ApiError && error.code === 'note_id_taken')) throw error
        id.current = newId()
        note = await diaryApi.addNote(id.current, clean, date)
      }
      id.current = newId()
      sentWith.current = null
      setText('')
      setProblem(null)
      onAdded(note)
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-4" data-add-note>
      <textarea
        rows={2}
        value={text}
        maxLength={5000}
        disabled={disabled}
        aria-label={t('write.addNote')}
        placeholder={t('write.addNoteHint')}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void add()
          }
        }}
        className="w-full resize-none rounded-xl border border-line bg-sheet px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60"
      />
      {problem && <p className="mt-1 text-sm text-bad">{errorText(problem)}</p>}
      <button
        type="button"
        onClick={() => void add()}
        disabled={!clean || busy || disabled}
        className="mt-2 inline-flex h-8 items-center justify-center gap-2 rounded-full bg-accent px-3.5 text-sm font-semibold text-accent-ink shadow-soft transition hover:brightness-105 disabled:pointer-events-none disabled:opacity-50"
      >
        {t('write.addNoteGo')}
      </button>
    </div>
  )
}
