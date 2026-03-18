'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Search, Building2, ClipboardList, Users, User, Loader2 } from 'lucide-react'

interface SearchResult {
  id: string
  title: string
  subtitle?: string
  type: 'account' | 'task' | 'lead' | 'contact'
  href: string
}

const TYPE_ICONS = {
  account: Building2,
  task: ClipboardList,
  lead: Users,
  contact: User,
}

const TYPE_LABELS = {
  account: 'Account',
  task: 'Task',
  lead: 'Lead',
  contact: 'Contact',
}

/**
 * Global search palette triggered by Cmd+K / Ctrl+K.
 * Pre-Coding Decision #9: only searches tables with existing pages.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<NodeJS.Timeout>()
  const router = useRouter()

  // Keyboard shortcut: Cmd+K / Ctrl+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(prev => !prev)
      }
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Focus input when opening
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50)
    } else {
      setQuery('')
      setResults([])
      setSelectedIndex(0)
    }
  }, [open])

  // Debounced search
  useEffect(() => {
    if (query.length < 2) {
      setResults([])
      setLoading(false)
      return
    }

    setLoading(true)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      try {
        // Phase 1: accounts + tasks only. Add tables as pages ship.
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&tables=accounts,tasks`)
        if (res.ok) {
          const data = await res.json()
          setResults(data.results ?? [])
          setSelectedIndex(0)
        }
      } catch {
        // silent
      } finally {
        setLoading(false)
      }
    }, 300)

    return () => clearTimeout(debounceRef.current)
  }, [query])

  const navigate = useCallback((result: SearchResult) => {
    setOpen(false)
    router.push(result.href)
  }, [router])

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results[selectedIndex]) {
      e.preventDefault()
      navigate(results[selectedIndex])
    }
  }

  if (!open) return null

  // Group results by type
  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    if (!acc[r.type]) acc[r.type] = []
    acc[r.type].push(r)
    return acc
  }, {})

  let flatIndex = -1

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={() => setOpen(false)} />

      {/* Palette */}
      <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[20vh]">
        <div
          className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden border"
          onClick={e => e.stopPropagation()}
        >
          {/* Search input */}
          <div className="flex items-center gap-3 px-4 border-b">
            <Search className="h-5 w-5 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search accounts, tasks..."
              className="flex-1 py-3.5 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
            />
            {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            <kbd className="hidden sm:inline-flex items-center gap-0.5 px-2 py-0.5 text-[10px] font-medium text-muted-foreground bg-zinc-100 rounded border">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div className="max-h-72 overflow-y-auto">
            {query.length < 2 && (
              <p className="px-4 py-8 text-sm text-center text-muted-foreground">
                Start typing to search...
              </p>
            )}

            {query.length >= 2 && !loading && results.length === 0 && (
              <p className="px-4 py-8 text-sm text-center text-muted-foreground">
                No results for &ldquo;{query}&rdquo;
              </p>
            )}

            {Object.entries(grouped).map(([type, items]) => (
              <div key={type}>
                <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-zinc-50">
                  {TYPE_LABELS[type as keyof typeof TYPE_LABELS] ?? type}
                </div>
                {items.map(result => {
                  flatIndex++
                  const isSelected = flatIndex === selectedIndex
                  const Icon = TYPE_ICONS[result.type] ?? Building2
                  const currentIndex = flatIndex

                  return (
                    <button
                      key={result.id}
                      onClick={() => navigate(result)}
                      onMouseEnter={() => setSelectedIndex(currentIndex)}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
                        isSelected ? 'bg-blue-50 text-blue-900' : 'hover:bg-zinc-50'
                      }`}
                    >
                      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{result.title}</p>
                        {result.subtitle && (
                          <p className="text-xs text-muted-foreground truncate">{result.subtitle}</p>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t bg-zinc-50 flex items-center gap-4 text-[10px] text-muted-foreground">
            <span><kbd className="px-1 py-0.5 bg-white rounded border text-[9px]">&uarr;</kbd> <kbd className="px-1 py-0.5 bg-white rounded border text-[9px]">&darr;</kbd> navigate</span>
            <span><kbd className="px-1 py-0.5 bg-white rounded border text-[9px]">&crarr;</kbd> open</span>
            <span><kbd className="px-1 py-0.5 bg-white rounded border text-[9px]">esc</kbd> close</span>
          </div>
        </div>
      </div>
    </>
  )
}
