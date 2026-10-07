/**
 * The tags of a day, as the mock's tag block: the chosen ones filled (a tap takes one away), "+ Tag" opens the
 * suggestions and a field for a tag of one's own. Used on "Today" and when writing a day up.
 */
import { Plus, Tag, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Chip } from './Chip'

export function TagPicker({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [own, setOwn] = useState('')
  const toggle = (tag: string) => onChange(tags.includes(tag) ? tags.filter((x) => x !== tag) : [...tags, tag])
  const suggestions = t('today.tagSuggestions')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag && !tags.includes(tag))
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <Chip key={tag} active onClick={() => toggle(tag)} label={t('today.removeTag', { tag })}>
            <Tag size={13} aria-hidden /> {tag} <X size={13} aria-hidden />
          </Chip>
        ))}
        <Chip onClick={() => setOpen(!open)} label={t('today.addTag')}>
          <Plus size={14} aria-hidden /> {t('today.tag')}
        </Chip>
      </div>
      {open && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="flex flex-wrap gap-2">
            {suggestions.map((tag) => (
              <Chip key={tag} onClick={() => toggle(tag)}>
                {tag}
              </Chip>
            ))}
          </div>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const tag = own.trim().replace(/^#/, '').toLowerCase()
              if (tag && !tags.includes(tag)) onChange([...tags, tag])
              setOwn('')
            }}
          >
            <input
              value={own}
              maxLength={40}
              onChange={(e) => setOwn(e.target.value)}
              placeholder={t('today.ownTag')}
              aria-label={t('today.ownTag')}
              className="h-8 min-w-0 flex-1 rounded-full border border-line bg-sheet px-3 text-sm text-ink outline-none placeholder:text-muted/70 focus:border-accent"
            />
            <button type="submit" disabled={!own.trim()} className="inline-flex h-8 items-center rounded-full border border-line px-3 text-sm font-semibold text-ink-2 hover:bg-sheet-2 disabled:opacity-50">
              {t('today.addTagButton')}
            </button>
          </form>
        </div>
      )}
    </>
  )
}
