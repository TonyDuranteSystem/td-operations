'use client'

// TD Social phone app, Inbox and WhatsApp lists (approved mockup "A slimmer top for the Inbox", 6 Nov 2026): ONE slim bar under the title instead of
// three stacked rows. At rest it holds [Folders] [All | Unread | Read] and a magnifier; tapping the magnifier turns the bar into the search box with
// Cancel and opens the keyboard in the same tap. While the box is open the three filters sit on a slim line under it (a filter that is on must never
// stay hidden), with the "Include archived" switch at the right end while a search is running. Pure arrangement: every value and handler is the
// shell's own, so the computer layout (which never renders this) and the search itself are untouched.
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type ListFilter = 'all' | 'unread' | 'read'

export const LIST_FILTERS: readonly { key: ListFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'read', label: 'Read' },
]

function FilterChips({ filter, onFilter }: { filter: ListFilter; onFilter: (f: ListFilter) => void }) {
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Show">
      {LIST_FILTERS.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          aria-pressed={filter === key}
          onClick={() => onFilter(key)}
          className={cn(
            'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
            filter === key
              ? key === 'unread' ? 'bg-blue-100 text-blue-700' : key === 'read' ? 'bg-zinc-200 text-zinc-700' : 'bg-zinc-100 text-zinc-600'
              : 'text-zinc-400'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export function AppListControls({
  hidden = false, folders, filter, onFilter, value, onChange, placeholder, onClear, onFocus, onKeyDown, scope, dropdown, defaultOpen = false,
}: {
  /** an open email or chat: the bar steps aside (it keeps its state, the shell keeps the text), so it is as it was on the way back */
  hidden?: boolean
  /** the Folders button (the Inbox only) */
  folders?: ReactNode
  filter: ListFilter
  onFilter: (f: ListFilter) => void
  /** the search text, owned by the shell */
  value: string
  onChange: (v: string) => void
  placeholder: string
  /** the box's own "x" and Cancel both end here: the shell empties the search */
  onClear: () => void
  onFocus?: () => void
  /** Enter / Escape, as the shell's own search box handles them */
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void
  /** the "Include archived" switch, shown while a search runs (the Inbox only) */
  scope?: ReactNode
  /** the type-ahead list under the box (the Inbox only) */
  dropdown?: ReactNode
  /** only for tests: start with the search box open */
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const inputRef = useRef<HTMLInputElement>(null)
  // text already in the box (a search that is running) keeps the box open
  const showField = open || value !== ''

  // The box has to exist before it can be focused, and the iPhone only opens the keyboard for a focus that happens inside the tap itself.
  const openSearch = () => {
    flushSync(() => setOpen(true))
    inputRef.current?.focus()
  }
  const cancel = () => {
    onClear()
    setOpen(false)
  }

  // An open email or chat: the bar's contents go, not just its look, so a typing box that still had the focus cannot leave the keyboard
  // up over the message box. The state (open, and the text, which the shell owns) stays, so the bar comes back as it was.
  if (hidden) return <div className="hidden" data-testid="app-list-controls" />

  return (
    <div className="relative border-b bg-zinc-50" data-testid="app-list-controls">
      {showField ? (
        <>
          <div className="relative z-[45] flex items-center gap-2 px-3 py-1.5">
            <div className="relative z-[55] flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-zinc-200/70 px-3">
              <Search className="h-4 w-4 shrink-0 text-zinc-500" />
              <input
                ref={inputRef}
                type="text"
                value={value}
                onChange={e => onChange(e.target.value)}
                onFocus={onFocus}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                enterKeyHint="search"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="Search"
                className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-zinc-400"
              />
              {value && (
                <button type="button" onClick={onClear} aria-label="Clear search" className="shrink-0 text-zinc-500">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <button type="button" onClick={cancel} className="relative z-[55] shrink-0 px-1 text-base font-medium text-blue-600">Cancel</button>
            {dropdown}
          </div>
          <div className="app-slim-buttons flex items-center gap-1 px-3 pb-1.5">
            <FilterChips filter={filter} onFilter={onFilter} />
            {scope && <div className="ml-auto">{scope}</div>}
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2 px-3 py-1">
          {folders}
          <FilterChips filter={filter} onFilter={onFilter} />
          <button type="button" onClick={openSearch} aria-label="Search" className="ml-auto shrink-0 text-zinc-600">
            <Search className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  )
}
