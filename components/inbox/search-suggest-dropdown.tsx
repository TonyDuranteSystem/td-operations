'use client'

import { useEffect, useState } from 'react'
import { Paperclip, Loader2 } from 'lucide-react'
import { shouldSuggest, SUGGEST_MIN_CHARS } from '@/lib/inbox/search-suggest'
import { cn } from '@/lib/utils'

export interface SearchSuggestion {
  id: string
  threadId: string
  subject: string
  sender: string
  senderEmail: string
  date: string | null
  hasAttachment: boolean
  unread: boolean
}

/** Short, Gmail-ish: time today, day+month this year, else with the year. */
function shortDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  }
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * The type-ahead list under the inbox search box (Antonio 2026-08-04).
 *
 * Debounced so a fast typist costs one request, not twelve. Every response is
 * checked against the query that is CURRENT when it lands — responses can
 * overtake each other, and showing a slow answer for "mar" under a box that now
 * reads "marco rossi" is worse than showing nothing.
 */
export function SearchSuggestDropdown({
  query,
  mailbox,
  onPick,
  onClose,
}: {
  query: string
  mailbox: string
  onPick: (s: SearchSuggestion) => void
  onClose: () => void
}) {
  const [items, setItems] = useState<SearchSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [active, setActive] = useState(0)

  const enabled = shouldSuggest(query)

  useEffect(() => {
    if (!enabled) {
      setItems([])
      setNotice(null)
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, mailbox })
        const res = await fetch(`/api/inbox/search-suggest?${params}`)
        const data = await res.json().catch(() => ({}))
        if (cancelled) return // a newer keystroke owns the box now
        if (!res.ok) {
          // R099 — say why, never a silent empty list.
          setNotice(data.error || 'Could not load suggestions — press Enter to search.')
          setItems([])
          return
        }
        setNotice(data.error ?? null)
        setItems(Array.isArray(data.suggestions) ? data.suggestions : [])
        setActive(0)
      } catch {
        if (!cancelled) {
          setNotice('Could not load suggestions — press Enter to search.')
          setItems([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, mailbox, enabled])

  // Arrow keys + Enter, captured while the dropdown is up. Enter on a highlighted
  // row opens THAT email; Enter with nothing highlighted falls through to the
  // search box's own handler and runs the full search, as it always has.
  useEffect(() => {
    if (!enabled || items.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => Math.min(i + 1, items.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, items.length, onClose])

  if (!enabled) return null

  const empty = !loading && items.length === 0 && !notice

  return (
    <>
      {/* Click-away. Behind the panel, above everything else. */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-white rounded-lg shadow-xl border border-zinc-200 overflow-hidden max-h-[22rem] overflow-y-auto">
        {loading && items.length === 0 && (
          <div className="flex items-center gap-2 px-3 py-2.5 text-sm text-zinc-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Searching…
          </div>
        )}

        {notice && (
          <div className="px-3 py-2 text-xs text-amber-700 bg-amber-50 border-b border-amber-100">
            {notice}
          </div>
        )}

        {empty && (
          <div className="px-3 py-2.5 text-sm text-zinc-400">
            No matches — press Enter to search everything.
          </div>
        )}

        {items.map((s, i) => (
          <button
            key={s.id}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(s)}
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 text-left border-b border-zinc-100 last:border-0 transition-colors',
              i === active ? 'bg-blue-50' : 'hover:bg-zinc-50',
            )}
          >
            <span
              className={cn(
                'w-1.5 h-1.5 rounded-full shrink-0',
                s.unread ? 'bg-blue-500' : 'bg-transparent',
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'text-sm truncate',
                    s.unread ? 'font-semibold text-zinc-900' : 'text-zinc-700',
                  )}
                >
                  {s.sender || s.senderEmail || '(unknown sender)'}
                </span>
                {s.hasAttachment && <Paperclip className="h-3 w-3 text-zinc-400 shrink-0" />}
              </span>
              <span className="block text-xs text-zinc-500 truncate">{s.subject}</span>
            </span>
            <span className="text-[11px] text-zinc-400 shrink-0">{shortDate(s.date)}</span>
          </button>
        ))}

        {items.length > 0 && (
          <div className="px-3 py-1.5 text-[11px] text-zinc-400 bg-zinc-50 border-t">
            Press Enter for all results
          </div>
        )}
      </div>
    </>
  )
}

export { SUGGEST_MIN_CHARS }
