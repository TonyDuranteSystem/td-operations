'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Search, X, Phone, Mail, UserCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FastTooltip } from '@/components/ui/fast-tooltip'
import {
  LEAD_STATUSES,
  OFFER_FILTERS,
  CALL_FILTERS,
  FOLLOW_UP_FILTERS,
  QUICK_FILTERS,
  hasActiveFilters,
  type LeadListFilters,
  type QuickKey,
} from '@/lib/leads/list-filters'

interface Suggestion {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  status: string | null
  existing_client_contact_id: string | null
}

interface LeadsFilterBarProps {
  query: string
  filters: LeadListFilters
  sources: string[]
  referrers: string[]
  quickCounts: Record<QuickKey, number>
  /** The board shows one column per status, so the status filter is hidden there. */
  isKanban: boolean
  shownCount: number
}

const SELECT_CLASS = 'px-3 py-2 rounded-lg border bg-white text-sm max-w-[200px]'

export function LeadsFilterBar({ query, filters, sources, referrers, quickCounts, isKanban, shownCount }: LeadsFilterBarProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()

  // The parameters we have actually asked the server for. Updated the instant
  // we act (not when the navigation lands) so two quick changes in a row —
  // say a dropdown then a quick button — never drop the first one.
  const paramsRef = useRef(new URLSearchParams(searchParams.toString()))
  useEffect(() => {
    paramsRef.current = new URLSearchParams(searchParams.toString())
  }, [searchParams])

  const askedQ = useRef(query)

  function setParams(changes: Record<string, string>) {
    if ('q' in changes) askedQ.current = changes.q
    const next = new URLSearchParams(paramsRef.current.toString())
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    next.delete('page') // a different list can have fewer pages
    paramsRef.current = next
    startTransition(() => router.push(`/leads?${next.toString()}`))
  }

  function clearAll() {
    setSearch('')
    setSuggestions([])
    setOpen(false)
    setParams({ q: '', status: '', src: '', ref: '', offer: '', call: '', follow: '', quick: '' })
  }

  // --- live search -------------------------------------------------------
  const [search, setSearch] = useState(query)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [searchError, setSearchError] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const requestId = useRef(0)

  // Keep the box in step when the URL changes from outside (back button, link).
  // Only a value we did NOT just ask for counts as an outside change; our own
  // navigation landing must never overwrite what the user has typed since.
  useEffect(() => {
    if (query !== askedQ.current) {
      askedQ.current = query
      setSearch(query)
    }
  }, [query])

  useEffect(() => {
    const q = search.trim()
    if (q.length < 2) {
      setSuggestions([])
      setSearchError('')
      return
    }
    const id = ++requestId.current
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/crm/leads/search?q=${encodeURIComponent(q)}`)
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || 'Search failed — please try again.')
        }
        const d = await res.json()
        if (id !== requestId.current) return // a newer keystroke already replaced this
        setSuggestions(d.results ?? [])
        setSearchError('')
        setOpen(true)
      } catch (err) {
        if (id !== requestId.current) return
        setSuggestions([])
        setSearchError(err instanceof Error && err.message ? err.message : 'Search failed — please try again.')
        setOpen(true)
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [search])

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    setOpen(false)
    setParams({ q: search.trim() })
  }

  function onSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value
    setSearch(value)
    // Clearing the box must reset the list straight away.
    if (value === '' && paramsRef.current.get('q')) setParams({ q: '' })
  }

  const active = hasActiveFilters(filters) || !!query

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3">
        <div ref={boxRef} className="relative w-full max-w-xl">
          <form onSubmit={submitSearch}>
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={onSearchChange}
              onFocus={() => { if (suggestions.length > 0 || searchError) setOpen(true) }}
              onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
              placeholder="Search name, email or phone…"
              aria-label="Search leads"
              className="w-full pl-9 pr-4 py-2 rounded-lg border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </form>
          {open && (suggestions.length > 0 || searchError || search.trim().length >= 2) && (
            <div className="absolute z-20 mt-1 w-full rounded-lg border bg-white shadow-lg overflow-hidden">
              {searchError ? (
                <p className="px-3 py-2 text-sm text-red-600">{searchError}</p>
              ) : suggestions.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">No lead matches “{search.trim()}”.</p>
              ) : (
                <>
                  {suggestions.map(s => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => { setOpen(false); router.push(`/leads/${s.id}`) }}
                      className="w-full text-left px-3 py-2 hover:bg-zinc-50 border-b last:border-b-0 flex items-center justify-between gap-3"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium truncate">{s.full_name}</span>
                        <span className="flex items-center gap-3 text-xs text-muted-foreground">
                          {s.email && <span className="flex items-center gap-1 truncate"><Mail className="h-3 w-3 shrink-0" />{s.email}</span>}
                          {s.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3 shrink-0" />{s.phone}</span>}
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {s.existing_client_contact_id && (
                          <span className="flex items-center gap-1 text-xs bg-zinc-100 text-zinc-600 px-1.5 py-0.5 rounded-md">
                            <UserCheck className="h-3 w-3" />Client
                          </span>
                        )}
                        {s.status && <span className="text-xs bg-zinc-100 text-zinc-700 px-1.5 py-0.5 rounded">{s.status}</span>}
                      </span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => { setOpen(false); setParams({ q: search.trim() }) }}
                    className="w-full text-left px-3 py-2 text-xs text-blue-600 hover:bg-zinc-50"
                  >
                    Show all matches in the list
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {!isKanban && (
            <select aria-label="Status" value={filters.status} onChange={e => setParams({ status: e.target.value })} className={SELECT_CLASS}>
              <option value="">All statuses</option>
              {LEAD_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <select aria-label="Offer" value={filters.offer} onChange={e => setParams({ offer: e.target.value })} className={SELECT_CLASS}>
            <option value="">Any offer</option>
            {OFFER_FILTERS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select aria-label="Call" value={filters.call} onChange={e => setParams({ call: e.target.value })} className={SELECT_CLASS}>
            <option value="">Any call</option>
            {CALL_FILTERS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <select aria-label="Follow-up" value={filters.follow} onChange={e => setParams({ follow: e.target.value })} className={SELECT_CLASS}>
            <option value="">Any follow-up</option>
            {FOLLOW_UP_FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <select aria-label="Source" value={filters.src} onChange={e => setParams({ src: e.target.value })} className={SELECT_CLASS}>
            <option value="">All sources</option>
            {sources.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select aria-label="Referrer" value={filters.ref} onChange={e => setParams({ ref: e.target.value })} className={SELECT_CLASS}>
            <option value="">Any referrer</option>
            {referrers.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {QUICK_FILTERS.map(q => {
          const on = filters.quick === q.key
          return (
            <FastTooltip key={q.key} label={q.hint}>
            <button
              type="button"
              aria-label={q.hint}
              onClick={() => setParams({ quick: on ? '' : q.key })}
              className={cn(
                'px-3 py-1 rounded-full border text-xs font-medium transition-colors',
                on ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 hover:bg-zinc-50',
              )}
            >
              {q.label} ({quickCounts[q.key]})
            </button>
            </FastTooltip>
          )
        })}
        {active && (
          <>
            <span className="text-xs text-muted-foreground ml-1">{shownCount} shown</span>
            <button type="button" onClick={clearAll} className="flex items-center gap-1 text-xs text-blue-600 hover:underline">
              <X className="h-3 w-3" />Clear all
            </button>
          </>
        )}
      </div>
    </div>
  )
}
