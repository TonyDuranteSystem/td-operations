'use client'

import { useState, useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'

interface ContactOption {
  id: string
  full_name: string
  email: string | null
  phone: string | null
}

interface ContactComboboxProps {
  value: string
  onChange: (id: string, contact: ContactOption | null) => void
  placeholder?: string
  excludeIds?: string[]
}

export function ContactCombobox({ value, onChange, placeholder = 'Search contacts...', excludeIds = [] }: ContactComboboxProps) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<ContactOption[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [selectedLabel, setSelectedLabel] = useState('')
  const [loading, setLoading] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (query.length < 2) { setOptions([]); return }
    const controller = new AbortController()
    setLoading(true)
    fetch(`/api/contacts/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
      .then(r => r.json())
      .then(data => {
        const filtered = (data.contacts ?? []).filter((c: ContactOption) => !excludeIds.includes(c.id))
        setOptions(filtered)
        setLoading(false)
      })
      .catch(() => setLoading(false))
    return () => controller.abort()
  }, [query, excludeIds])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const handleSelect = (c: ContactOption) => {
    onChange(c.id, c)
    setSelectedLabel(c.full_name)
    setQuery('')
    setIsOpen(false)
  }

  const handleClear = () => {
    onChange('', null)
    setSelectedLabel('')
    setQuery('')
  }

  return (
    <div ref={wrapperRef} className="relative">
      {value && selectedLabel ? (
        <div className="flex items-center gap-2 px-3 py-2 text-sm border rounded-md bg-zinc-50">
          <span className="flex-1 truncate">{selectedLabel}</span>
          <button type="button" onClick={handleClear} className="text-zinc-400 hover:text-zinc-600">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setIsOpen(true) }}
            onFocus={() => query.length >= 2 && setIsOpen(true)}
            placeholder={placeholder}
            className="w-full pl-9 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}
      {isOpen && (query.length >= 2) && (
        <div className="absolute z-10 mt-1 w-full bg-white border rounded-md shadow-lg max-h-48 overflow-y-auto">
          {loading && <div className="px-3 py-2 text-xs text-muted-foreground">Searching...</div>}
          {!loading && options.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No contacts found</div>}
          {options.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => handleSelect(c)}
              className="w-full text-left px-3 py-2 hover:bg-zinc-50 border-b last:border-b-0"
            >
              <div className="text-sm font-medium">{c.full_name}</div>
              <div className="text-xs text-muted-foreground">{c.email ?? c.phone ?? ''}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
