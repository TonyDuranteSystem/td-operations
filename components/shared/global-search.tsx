'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  Search, Building2, ClipboardList, Users, User, Loader2,
  FileText, Activity, Receipt, CalendarDays, X,
  Mail, Phone, Briefcase, Hash, MapPin, Tag,
} from 'lucide-react'
import type { EnhancedSearchResult } from '@/lib/types'

// ─── Config ─────────────────────────────────────────────

const TYPE_ICONS: Record<string, typeof Building2> = {
  account: Building2,
  task: ClipboardList,
  lead: Users,
  contact: User,
  document: FileText,
  service: Activity,
  invoice: Receipt,
  deadline: CalendarDays,
}

const CRM_TYPE_LABELS: Record<string, string> = {
  account: 'Accounts',
  task: 'Tasks',
  lead: 'Leads',
  contact: 'Contacts',
}

const PORTAL_TYPE_LABELS: Record<string, string> = {
  document: 'Documents',
  service: 'Services',
  invoice: 'Billing',
  deadline: 'Deadlines',
}

// ─── Props ──────────────────────────────────────────────

interface GlobalSearchProps {
  searchEndpoint: string
  mode: 'crm' | 'portal'
  accountId?: string
  placeholder?: string
}

// ─── Component ──────────────────────────────────────────

export function GlobalSearch({ searchEndpoint, mode, accountId, placeholder = 'Search...' }: GlobalSearchProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<EnhancedSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [mounted, setMounted] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<NodeJS.Timeout>()
  const dropdownRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  const typeLabels = mode === 'crm' ? CRM_TYPE_LABELS : PORTAL_TYPE_LABELS

  // Portal mounting
  useEffect(() => { setMounted(true) }, [])

  // Cmd+K to focus
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }
    // Also listen for the custom event from mobile header
    function handleFocusSearch() {
      inputRef.current?.focus()
      setOpen(true)
    }
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('focus-global-search', handleFocusSearch)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('focus-global-search', handleFocusSearch)
    }
  }, [])

  // Close on click outside
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      if (
        containerRef.current && !containerRef.current.contains(target) &&
        dropdownRef.current && !dropdownRef.current.contains(target)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
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
        const params = new URLSearchParams({ q: query })
        if (mode === 'portal' && accountId) params.set('account_id', accountId)
        const res = await fetch(`${searchEndpoint}?${params}`)
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
  }, [query, searchEndpoint, mode, accountId])

  const navigate = useCallback((result: EnhancedSearchResult) => {
    setOpen(false)
    setQuery('')
    setResults([])
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
    } else if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
    }
  }

  // Group results by type
  const grouped = results.reduce<Record<string, EnhancedSearchResult[]>>((acc, r) => {
    if (!acc[r.type]) acc[r.type] = []
    acc[r.type].push(r)
    return acc
  }, {})

  // Flatten for index tracking
  const flatResults = Object.values(grouped).flat()
  const selectedResult = flatResults[selectedIndex] ?? null

  // Dropdown position (anchored to input)
  const getDropdownStyle = (): React.CSSProperties => {
    if (!containerRef.current) return {}
    const rect = containerRef.current.getBoundingClientRect()
    return {
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      zIndex: 70,
    }
  }

  let flatIndex = -1

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); if (!open) setOpen(true) }}
          onFocus={() => { if (query.length >= 2) setOpen(true) }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-full pl-8 pr-8 py-2 rounded-md text-sm bg-sidebar-accent/50 border border-sidebar-border text-sidebar-foreground placeholder:text-sidebar-foreground/40 outline-none focus:ring-1 focus:ring-blue-500/50 focus:border-blue-500/50 transition-colors"
        />
        {loading && <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {!loading && query.length > 0 && (
          <button
            onClick={() => { setQuery(''); setResults([]); setOpen(false) }}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-sidebar-accent"
          >
            <X className="h-3 w-3 text-muted-foreground" />
          </button>
        )}
      </div>

      {/* Dropdown via portal */}
      {open && query.length >= 2 && mounted && createPortal(
        <>
          {/* Invisible backdrop for mobile */}
          <div className="fixed inset-0 z-[69] lg:hidden" onClick={() => setOpen(false)} />

          <div
            ref={dropdownRef}
            style={getDropdownStyle()}
            className="w-[min(620px,95vw)] bg-white rounded-xl shadow-2xl border border-zinc-200 overflow-hidden"
          >
            <div className="flex">
              {/* Left: Result list */}
              <div className="w-full lg:w-[300px] max-h-[400px] overflow-y-auto border-r border-zinc-100">
                {!loading && results.length === 0 && (
                  <p className="px-4 py-8 text-sm text-center text-zinc-400">
                    No results for &ldquo;{query}&rdquo;
                  </p>
                )}

                {Object.entries(grouped).map(([type, items]) => (
                  <div key={type}>
                    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 bg-zinc-50 sticky top-0">
                      {typeLabels[type] ?? type}
                    </div>
                    {items.map(result => {
                      flatIndex++
                      const isSelected = flatIndex === selectedIndex
                      const Icon = TYPE_ICONS[result.type] ?? Building2
                      const idx = flatIndex

                      return (
                        <button
                          key={result.id}
                          onClick={() => navigate(result)}
                          onMouseEnter={() => setSelectedIndex(idx)}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                            isSelected ? 'bg-blue-50 text-blue-900' : 'hover:bg-zinc-50 text-zinc-700'
                          }`}
                        >
                          <Icon className="h-4 w-4 text-zinc-400 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate text-[13px]">{result.title}</p>
                            {result.subtitle && (
                              <p className="text-[11px] text-zinc-400 truncate">{result.subtitle}</p>
                            )}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>

              {/* Right: Preview panel (desktop only) */}
              <div className="hidden lg:block w-[320px] max-h-[400px] overflow-y-auto bg-zinc-50/50 p-4">
                {selectedResult ? (
                  <PreviewCard result={selectedResult} mode={mode} />
                ) : (
                  <div className="flex items-center justify-center h-full text-sm text-zinc-400">
                    Select a result to preview
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-3 py-1.5 border-t bg-zinc-50 flex items-center gap-4 text-[10px] text-zinc-400">
              <span><kbd className="px-1 py-0.5 bg-white rounded border text-[9px]">&uarr;</kbd> <kbd className="px-1 py-0.5 bg-white rounded border text-[9px]">&darr;</kbd> navigate</span>
              <span><kbd className="px-1 py-0.5 bg-white rounded border text-[9px]">&crarr;</kbd> open</span>
              <span><kbd className="px-1 py-0.5 bg-white rounded border text-[9px]">esc</kbd> close</span>
              {mode === 'crm' && (
                <span className="ml-auto"><kbd className="px-1 py-0.5 bg-white rounded border text-[9px]">{'\u2318'}K</kbd></span>
              )}
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  )
}

// ─── Preview Card ───────────────────────────────────────

function PreviewCard({ result, mode }: { result: EnhancedSearchResult; mode: 'crm' | 'portal' }) {
  const p = result.preview
  const Icon = TYPE_ICONS[result.type] ?? Building2

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-start gap-2">
        <div className="p-1.5 rounded-md bg-blue-100 text-blue-600 shrink-0">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-sm text-zinc-900 truncate">{result.title}</p>
          {result.subtitle && <p className="text-xs text-zinc-500">{result.subtitle}</p>}
        </div>
      </div>

      <div className="border-t border-zinc-200" />

      {/* Type-specific fields */}
      {result.type === 'account' && <AccountPreview p={p} />}
      {result.type === 'contact' && <ContactPreview p={p} />}
      {result.type === 'task' && <TaskPreview p={p} />}
      {result.type === 'lead' && <LeadPreview p={p} />}
      {result.type === 'document' && <DocumentPreview p={p} />}
      {result.type === 'service' && <ServicePreview p={p} />}
      {result.type === 'invoice' && <InvoicePreview p={p} />}
      {result.type === 'deadline' && <DeadlinePreview p={p} />}

      {/* Open link */}
      <div className="pt-1">
        <span className="text-[11px] text-blue-600 font-medium">
          Press Enter to open {mode === 'crm' ? 'in CRM' : ''} &rarr;
        </span>
      </div>
    </div>
  )
}

// ─── Preview Sections ───────────────────────────────────

function Field({ icon: Icon, label, value }: { icon: typeof Building2; label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div className="flex items-start gap-2 text-xs">
      <Icon className="h-3.5 w-3.5 text-zinc-400 mt-0.5 shrink-0" />
      <div>
        <span className="text-zinc-400">{label}:</span>{' '}
        <span className="text-zinc-700">{value}</span>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null
  const colors: Record<string, string> = {
    Active: 'bg-green-100 text-green-700',
    'To Do': 'bg-yellow-100 text-yellow-700',
    'In Progress': 'bg-blue-100 text-blue-700',
    Waiting: 'bg-orange-100 text-orange-700',
    Pending: 'bg-yellow-100 text-yellow-700',
    Paid: 'bg-green-100 text-green-700',
    Overdue: 'bg-red-100 text-red-700',
    Filed: 'bg-green-100 text-green-700',
  }
  return (
    <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[status] ?? 'bg-zinc-100 text-zinc-600'}`}>
      {status}
    </span>
  )
}

function AccountPreview({ p }: { p: EnhancedSearchResult['preview'] }) {
  return (
    <div className="space-y-2">
      <Field icon={Hash} label="EIN" value={p.ein} />
      <Field icon={MapPin} label="State" value={p.state} />
      <Field icon={Briefcase} label="Type" value={p.entity_type} />
      {p.status && (
        <div className="flex items-center gap-2 text-xs">
          <Tag className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
          <StatusBadge status={p.status} />
        </div>
      )}
      {p.contacts && p.contacts.length > 0 && (
        <div className="pt-1">
          <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-1">Contacts</p>
          {p.contacts.map((c, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs text-zinc-600 py-0.5">
              <User className="h-3 w-3 text-zinc-400" />
              <span>{c.name}</span>
              {c.email && <span className="text-zinc-400 truncate">({c.email})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ContactPreview({ p }: { p: EnhancedSearchResult['preview'] }) {
  return (
    <div className="space-y-2">
      <Field icon={Mail} label="Email" value={p.email} />
      <Field icon={Phone} label="Phone" value={p.phone} />
      {p.companies && p.companies.length > 0 && (
        <div className="pt-1">
          <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider mb-1">Companies</p>
          {p.companies.map((c, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs text-zinc-600 py-0.5">
              <Building2 className="h-3 w-3 text-zinc-400" />
              <span>{c.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TaskPreview({ p }: { p: EnhancedSearchResult['preview'] }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge status={p.status} />
        {p.priority && (
          <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${
            p.priority === 'Urgent' ? 'bg-red-100 text-red-700' :
            p.priority === 'High' ? 'bg-orange-100 text-orange-700' :
            'bg-zinc-100 text-zinc-600'
          }`}>{p.priority}</span>
        )}
      </div>
      <Field icon={User} label="Assigned" value={p.assigned_to} />
      {p.description && (
        <p className="text-xs text-zinc-600 leading-relaxed">{p.description}</p>
      )}
    </div>
  )
}

function LeadPreview({ p }: { p: EnhancedSearchResult['preview'] }) {
  return (
    <div className="space-y-2">
      {p.status && <StatusBadge status={p.status} />}
      <Field icon={Tag} label="Source" value={p.source} />
      <Field icon={Briefcase} label="Reason" value={p.reason} />
      <Field icon={Phone} label="Channel" value={p.channel} />
    </div>
  )
}

function DocumentPreview({ p }: { p: EnhancedSearchResult['preview'] }) {
  return (
    <div className="space-y-2">
      <Field icon={FileText} label="Type" value={p.document_type} />
      <Field icon={Tag} label="Category" value={p.category} />
    </div>
  )
}

function ServicePreview({ p }: { p: EnhancedSearchResult['preview'] }) {
  return (
    <div className="space-y-2">
      <Field icon={Activity} label="Type" value={p.service_type} />
      <Field icon={Tag} label="Stage" value={p.stage} />
      {p.status && <StatusBadge status={p.status} />}
    </div>
  )
}

function InvoicePreview({ p }: { p: EnhancedSearchResult['preview'] }) {
  return (
    <div className="space-y-2">
      {p.amount != null && (
        <div className="text-lg font-semibold text-zinc-900">
          {p.currency ?? 'USD'} {p.amount.toLocaleString()}
        </div>
      )}
      {p.status && <StatusBadge status={p.status} />}
      <Field icon={CalendarDays} label="Due" value={p.due_date} />
    </div>
  )
}

function DeadlinePreview({ p }: { p: EnhancedSearchResult['preview'] }) {
  return (
    <div className="space-y-2">
      <Field icon={CalendarDays} label="Due" value={p.due_date} />
      {p.status && <StatusBadge status={p.status} />}
    </div>
  )
}
