'use client'

import { useState, useEffect, useRef } from 'react'
import { ChevronDown, MapPin, X, Search, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { AddressKind, AddressRow } from '@/lib/addresses'

export type { AddressRow }

interface AddressDropdownProps {
  kind: AddressKind
  value: string | null
  onChange: (row: AddressRow | null) => void
  placeholder?: string
  className?: string
  disabled?: boolean
}

function subtitleLine(row: AddressRow): string {
  return [row.city, row.state, row.zip].filter(Boolean).join(' ')
}

function matchesSearch(row: AddressRow, q: string): boolean {
  const lower = q.toLowerCase()
  return (
    row.name.toLowerCase().includes(lower) ||
    row.city.toLowerCase().includes(lower) ||
    row.state.toLowerCase().includes(lower) ||
    (row.county?.toLowerCase().includes(lower) ?? false)
  )
}

export function AddressDropdown({
  kind,
  value,
  onChange,
  placeholder = 'Select address...',
  className,
  disabled = false,
}: AddressDropdownProps) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<AddressRow[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const selectedRow = rows.find(r => r.id === value) ?? null

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Fetch once on first open
  useEffect(() => {
    if (!open || loaded) return
    setLoading(true)
    fetch(`/api/addresses?kind=${encodeURIComponent(kind)}&active=true`)
      .then(async res => {
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to load addresses')
        setRows(data as AddressRow[])
        setLoaded(true)
      })
      .catch(err => {
        toast.error(err instanceof Error ? err.message : 'Failed to load addresses')
      })
      .finally(() => setLoading(false))
  }, [open, loaded, kind])

  // Focus search when panel opens
  useEffect(() => {
    if (open && searchRef.current) searchRef.current.focus()
  }, [open])

  const filtered = search.trim() ? rows.filter(r => matchesSearch(r, search)) : rows

  const handleSelect = (row: AddressRow) => {
    onChange(row)
    setOpen(false)
    setSearch('')
  }

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation()
    onChange(null)
  }

  const toggleOpen = () => {
    if (!disabled) setOpen(prev => !prev)
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {/* Trigger row — outer div is the visual "input" box; inner parts are siblings */}
      <div
        className={cn(
          'flex items-center gap-1 border rounded-md bg-white',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        )}
      >
        {/* Clickable area: opens/closes the panel */}
        <button
          type="button"
          disabled={disabled}
          onClick={toggleOpen}
          className={cn(
            'flex items-center gap-2 flex-1 min-w-0 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-l-md',
            !selectedRow && 'text-muted-foreground'
          )}
        >
          <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          {selectedRow ? (
            <div className="min-w-0 flex-1 text-left">
              <span className="block truncate font-medium text-zinc-900 text-sm">
                {selectedRow.name}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {subtitleLine(selectedRow)}
              </span>
            </div>
          ) : (
            <span className="text-sm">{placeholder}</span>
          )}
          <ChevronDown
            className={cn('h-4 w-4 text-muted-foreground transition-transform shrink-0', open && 'rotate-180')}
          />
        </button>

        {/* Clear button — only visible when a value is selected */}
        {selectedRow && !disabled && (
          <button
            type="button"
            onClick={handleClear}
            className="px-2 py-2 rounded-r-md hover:bg-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            title="Clear selection"
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border rounded-md shadow-lg">
          {/* Search input */}
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filter by name, city, state..."
                className="w-full pl-8 pr-3 py-1.5 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Address list */}
          <div className="max-h-60 overflow-y-auto">
            {loading && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
              </div>
            )}

            {!loading && filtered.length === 0 && (
              <p className="px-3 py-3 text-sm text-muted-foreground text-center">
                {rows.length === 0 ? 'No addresses registered for this kind' : 'No matches'}
              </p>
            )}

            {!loading &&
              filtered.map(row => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => handleSelect(row)}
                  className={cn(
                    'w-full flex items-start gap-2 px-3 py-2.5 text-sm text-left hover:bg-zinc-50 transition-colors',
                    value === row.id && 'bg-blue-50'
                  )}
                >
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <span
                      className={cn(
                        'block truncate font-medium',
                        value === row.id && 'text-blue-700'
                      )}
                    >
                      {row.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {subtitleLine(row)}
                      {row.county ? ` · ${row.county} County` : ''}
                    </span>
                  </div>
                  {row.linked_account_count > 0 && (
                    <span className="shrink-0 self-center text-xs text-muted-foreground bg-zinc-100 px-1.5 py-0.5 rounded-full">
                      {row.linked_account_count}
                    </span>
                  )}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
