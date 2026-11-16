'use client'

/**
 * The search box of the Contacts and Accounts lists, with a dropdown of matches WHILE YOU TYPE (Antonio 2026-11-15).
 *
 * Typing asks the same search the global search uses (GET /api/search, only the wanted kind) after a short pause and shows up to
 * eight matches under the box: pick one (click, or arrow keys + Enter) to open it. Enter with nothing highlighted still does what it
 * always did — filters the whole list by what you typed — so the list's own filtering is untouched. Escape, a click elsewhere or Tab
 * closes the dropdown; a reply that arrives after you typed something newer is ignored.
 */
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Search, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SEARCH_DEBOUNCE_MS, dropdownRows, nextHighlight, searchableQuery, type DropdownRow } from '@/lib/crm-lists/search-dropdown'

export function ListSearchBox({ kind, value, onChange, onSubmit, placeholder }: {
  kind: 'contact' | 'account'
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onSubmit: (e: React.FormEvent) => void
  placeholder: string
}) {
  const router = useRouter()
  const [rows, setRows] = useState<DropdownRow[]>([])
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState(false) // the latest search has answered (so "no matches" is true, not "still waiting")
  const [loading, setLoading] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const boxRef = useRef<HTMLFormElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const abortRef = useRef<AbortController>()
  const seqRef = useRef(0)
  const listId = `list-search-${kind}`

  const close = () => { setOpen(false); setHighlight(-1) }

  function schedule(text: string) {
    clearTimeout(timerRef.current)
    abortRef.current?.abort()
    const seq = ++seqRef.current
    const q = searchableQuery(text)
    if (!q) { setRows([]); setDone(false); setLoading(false); close(); return }
    setLoading(true)
    timerRef.current = setTimeout(async () => {
      const ac = new AbortController()
      abortRef.current = ac
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&tables=${kind === 'contact' ? 'contacts' : 'accounts'}`, { signal: ac.signal, cache: 'no-store' })
        if (!res.ok) throw new Error('search failed')
        const data = (await res.json()) as { results?: Parameters<typeof dropdownRows>[0] }
        if (seq !== seqRef.current) return // the user typed something newer
        setRows(dropdownRows(data.results ?? [], kind)); setDone(true); setHighlight(-1); setOpen(true)
      } catch {
        if (seq !== seqRef.current) return
        setRows([]); setDone(false); close() // a failed search just shows no dropdown; Enter still filters the list
      } finally {
        if (seq === seqRef.current) setLoading(false)
      }
    }, SEARCH_DEBOUNCE_MS)
  }

  useEffect(() => () => { clearTimeout(timerRef.current); abortRef.current?.abort() }, [])

  // a press anywhere outside closes the dropdown
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) close() }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { if (open) { e.preventDefault(); close() } return }
    if (e.key === 'Tab') { close(); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (rows.length === 0) return
      e.preventDefault()
      if (!open) { setOpen(true); return }
      setHighlight((h) => nextHighlight(h, e.key === 'ArrowDown' ? 1 : -1, rows.length))
      return
    }
    if (e.key === 'Enter' && open && highlight >= 0 && rows[highlight]) {
      e.preventDefault()
      const href = rows[highlight].href
      close()
      router.push(href)
    }
  }

  const showList = open && done
  return (
    <form
      ref={boxRef}
      onSubmit={(e) => { close(); onSubmit(e) }}
      className="relative w-full max-w-md flex-1"
    >
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <input
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && highlight >= 0 ? `${listId}-${highlight}` : undefined}
        autoComplete="off"
        value={value}
        onChange={(e) => { onChange(e); schedule(e.target.value) }}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (rows.length > 0 && done && searchableQuery(value)) setOpen(true) }}
        placeholder={placeholder}
        className="w-full pl-9 pr-9 py-2 rounded-lg border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {loading && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden />}
      {showList && (
        <div id={listId} role="listbox" className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border bg-white shadow-lg">
          {rows.length === 0 ? (
            <p className="px-3 py-2.5 text-sm text-muted-foreground">No {kind === 'contact' ? 'contact' : 'company'} matches “{value.trim()}”.</p>
          ) : (
            rows.map((r, i) => (
              <Link
                key={r.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === highlight}
                href={r.href}
                onMouseDown={(e) => e.preventDefault()} // keep the focus in the box
                onMouseEnter={() => setHighlight(i)}
                onClick={close}
                className={cn('block border-b px-3 py-2 last:border-b-0', i === highlight ? 'bg-blue-50' : 'hover:bg-zinc-50')}
              >
                <span className="block truncate text-sm font-medium text-zinc-900">{r.title}</span>
                {r.detail && <span className="block truncate text-xs text-muted-foreground">{r.detail}</span>}
              </Link>
            ))
          )}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => boxRef.current?.requestSubmit()}
            className="block w-full border-t bg-zinc-50 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-zinc-100"
          >
            Press Enter to show all matches in the list
          </button>
        </div>
      )}
    </form>
  )
}
