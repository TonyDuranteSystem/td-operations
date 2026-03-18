'use client'

import { useState, useEffect, useRef } from 'react'
import { Search, X, Building2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AccountOption {
  id: string
  company_name: string
  status?: string
}

interface AccountComboboxProps {
  value?: string
  displayValue?: string
  onChange: (accountId: string | undefined, companyName: string | undefined) => void
  placeholder?: string
  className?: string
}

/**
 * Shared searchable account picker.
 * Debounced search, returns { id, company_name }.
 * Reused across task dialogs, inbox CRM linking, invoices, leads.
 */
export function AccountCombobox({
  value,
  displayValue,
  onChange,
  placeholder = 'Search accounts...',
  className,
}: AccountComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AccountOption[]>([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<NodeJS.Timeout>()

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Debounced search
  useEffect(() => {
    if (query.length < 2) {
      setResults([])
      return
    }

    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/accounts?q=${encodeURIComponent(query)}&limit=8`)
        if (res.ok) {
          const data = await res.json()
          setResults(data.accounts ?? [])
        }
      } catch {
        // silent
      } finally {
        setLoading(false)
      }
    }, 300)

    return () => clearTimeout(debounceRef.current)
  }, [query])

  const handleSelect = (account: AccountOption) => {
    onChange(account.id, account.company_name)
    setQuery('')
    setOpen(false)
  }

  const handleClear = () => {
    onChange(undefined, undefined)
    setQuery('')
  }

  // Show selected value or search input
  if (value && displayValue && !open) {
    return (
      <div className={cn('flex items-center gap-2 px-3 py-2 border rounded-md bg-white', className)}>
        <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm flex-1 truncate">{displayValue}</span>
        <button
          type="button"
          onClick={handleClear}
          className="p-0.5 rounded hover:bg-zinc-100"
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>
    )
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="w-full pl-9 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {open && (query.length >= 2 || results.length > 0) && (
        <div className="absolute z-50 mt-1 w-full bg-white border rounded-md shadow-lg max-h-48 overflow-y-auto">
          {loading && (
            <p className="px-3 py-2 text-sm text-muted-foreground">Searching...</p>
          )}
          {!loading && results.length === 0 && query.length >= 2 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">No accounts found</p>
          )}
          {results.map(account => (
            <button
              key={account.id}
              type="button"
              onClick={() => handleSelect(account)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-zinc-50 transition-colors"
            >
              <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="truncate">{account.company_name}</span>
              {account.status && (
                <span className="text-xs text-muted-foreground ml-auto shrink-0">{account.status}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
