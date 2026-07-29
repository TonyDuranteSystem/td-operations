'use client'

/**
 * To-field autocomplete for the email composer (Luca's request 2026-07-29).
 * Wraps a plain email input: as the user types 2+ characters, suggests
 * addresses from /api/inbox/recipients-search (all CRM emails + Inbox
 * history). Selecting fills the field; typing a raw address still works —
 * the dropdown is assistive, never required, and any fetch failure simply
 * shows nothing.
 */

import { useEffect, useRef, useState } from 'react'
import { User, Building2, Mail, AtSign } from 'lucide-react'
import type { RecipientSuggestion } from '@/lib/inbox/recipient-search'

const SOURCE_LABEL: Record<RecipientSuggestion['source'], string> = {
  contact: 'Contact',
  member: 'Member',
  partner: 'Partner',
  lead: 'Lead',
  account: 'Account',
  inbox: 'Inbox',
}

function SourceIcon({ source }: { source: RecipientSuggestion['source'] }) {
  if (source === 'account') return <Building2 className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
  if (source === 'inbox') return <Mail className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
  return <User className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
}

interface RecipientAutocompleteProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

export function RecipientAutocomplete({
  value,
  onChange,
  placeholder = 'recipient@example.com',
  className,
}: RecipientAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<RecipientSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const containerRef = useRef<HTMLDivElement>(null)
  // A just-picked suggestion re-triggers the value effect; this stops the
  // dropdown from instantly reopening over the filled field.
  const suppressRef = useRef(false)
  // Only searches typed by the user open the dropdown — a prefilled To
  // (reply-to-lead flows) must not pop suggestions over the dialog unasked.
  const hasTypedRef = useRef(false)
  // Monotonic token: only the LATEST request may touch state. Out-of-order
  // responses ("lu" landing after "luca") and responses landing after a pick
  // would otherwise show stale rows an Enter could then mis-send (council
  // major 2026-07-29).
  const requestSeqRef = useRef(0)

  useEffect(() => {
    clearTimeout(debounceRef.current)
    if (suppressRef.current) {
      suppressRef.current = false
      return
    }
    if (!hasTypedRef.current) return
    const q = value.trim()
    if (q.length < 2) {
      setSuggestions([])
      setOpen(false)
      return
    }
    const seq = ++requestSeqRef.current
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/inbox/recipients-search?q=${encodeURIComponent(q)}`)
        if (seq !== requestSeqRef.current) return // superseded or picked
        if (!res.ok) return
        const data = await res.json()
        if (seq !== requestSeqRef.current) return
        const list: RecipientSuggestion[] = Array.isArray(data.suggestions) ? data.suggestions : []
        // Don't re-suggest the exact address already fully typed/picked.
        const filtered = list.filter((s) => s.email.toLowerCase() !== q.toLowerCase())
        setSuggestions(filtered)
        setHighlighted(-1)
        setOpen(filtered.length > 0)
      } catch {
        // Assistive only — silence is the correct failure mode here.
      }
    }, 250)
    return () => clearTimeout(debounceRef.current)
  }, [value])

  // Close on outside click.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const pick = (s: RecipientSuggestion) => {
    suppressRef.current = true
    requestSeqRef.current++ // invalidate any in-flight response
    onChange(s.email)
    setOpen(false)
    setSuggestions([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => (h + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => (h <= 0 ? suggestions.length - 1 : h - 1))
    } else if (e.key === 'Enter' && highlighted >= 0) {
      e.preventDefault()
      pick(suggestions[highlighted])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={containerRef} className="relative flex-1">
      <input
        type="email"
        value={value}
        onChange={(e) => {
          hasTypedRef.current = true
          onChange(e.target.value)
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setOpen(suggestions.length > 0)}
        placeholder={placeholder}
        className={className ?? 'w-full text-sm outline-none bg-transparent'}
        required
      />
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 rounded-lg border border-zinc-200 bg-white shadow-lg max-h-64 overflow-y-auto">
          {suggestions.map((s, i) => (
            <button
              key={`${s.email}-${s.source}`}
              type="button"
              // onMouseDown so the pick lands before the input's blur.
              onMouseDown={(e) => {
                e.preventDefault()
                pick(s)
              }}
              onMouseEnter={() => setHighlighted(i)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${
                i === highlighted ? 'bg-blue-50' : 'hover:bg-zinc-50'
              }`}
            >
              <SourceIcon source={s.source} />
              <span className="min-w-0 flex-1 truncate">
                {s.name ? (
                  <>
                    <span className="font-medium text-zinc-800">{s.name}</span>
                    <span className="text-zinc-500"> — {s.email}</span>
                  </>
                ) : (
                  <span className="text-zinc-700">{s.email}</span>
                )}
                {s.company && <span className="text-zinc-400"> · {s.company}</span>}
              </span>
              <span className="shrink-0 inline-flex items-center gap-1 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                <AtSign className="h-2.5 w-2.5" />
                {SOURCE_LABEL[s.source]}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
