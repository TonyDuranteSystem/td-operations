'use client'

import { useState, useMemo } from 'react'
import { Search, CheckCircle2, Flag, AlertCircle, Clock, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AuditPanel } from './audit-panel'
import { format, parseISO } from 'date-fns'

export type ContactRow = {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  language: string | null
  citizenship: string | null
  itin: string | null
  portal_tier: string | null
}

export type AccountRow = {
  id: string
  company_name: string
  status: string | null
  entity_type: string | null
  account_type: string | null
  formation_date: string | null
  onboarding_date: string | null
  ein_number: string | null
  filing_id: string | null
  state_of_formation: string | null
  physical_address: string | null
  notes: string | null
  installment_1_amount: number | null
  installment_1_currency: string | null
  installment_2_amount: number | null
  installment_2_currency: string | null
  setup_fee_amount: number | null
  setup_fee_invoice: string | null
  setup_fee_date: string | null
  audit_reviewed_at: string | null
  audit_reviewed_by: string | null
  audit_flag: boolean | null
  audit_sections: Record<string, boolean> | null
  drive_folder_id: string | null
  contacts: ContactRow[]
  anomaly_score: number
}

type ShowFilter = 'all' | 'unreviewed' | 'reviewed' | 'flagged'
type StatusFilter = 'all' | 'Active' | 'Delinquent' | 'Offboarding' | 'Suspended'

const REVIEWERS = ['Antonio', 'Luca']

export function AuditShell({
  accounts: initialAccounts,
  total,
}: {
  accounts: AccountRow[]
  total: number
}) {
  const [accounts, setAccounts] = useState(initialAccounts)
  const [selectedId, setSelectedId] = useState<string | null>(accounts[0]?.id ?? null)
  const [search, setSearch] = useState('')
  const [showFilter, setShowFilter] = useState<ShowFilter>('unreviewed')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [reviewer, setReviewer] = useState<string>('Antonio')

  const reviewed = accounts.filter(a => a.audit_reviewed_at).length

  const filtered = useMemo(() => {
    let list = accounts
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(a => a.company_name.toLowerCase().includes(q))
    }
    if (showFilter === 'unreviewed') list = list.filter(a => !a.audit_reviewed_at)
    if (showFilter === 'reviewed') list = list.filter(a => !!a.audit_reviewed_at)
    if (showFilter === 'flagged') list = list.filter(a => a.audit_flag)
    if (statusFilter !== 'all') list = list.filter(a => a.status === statusFilter)
    return list
  }, [accounts, search, showFilter, statusFilter])

  const selectedIndex = filtered.findIndex(a => a.id === selectedId)
  const selected = selectedIndex >= 0 ? filtered[selectedIndex] : null

  function handleAccountUpdated(updated: AccountRow) {
    setAccounts(prev => prev.map(a => a.id === updated.id ? { ...a, ...updated } : a))
  }

  function goNext() {
    if (selectedIndex < filtered.length - 1) {
      setSelectedId(filtered[selectedIndex + 1].id)
    }
  }

  function goPrev() {
    if (selectedIndex > 0) {
      setSelectedId(filtered[selectedIndex - 1].id)
    }
  }

  const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      {/* Top bar */}
      <div className="border-b bg-white px-6 py-3 flex items-center gap-6 shrink-0">
        <div>
          <h1 className="text-lg font-semibold">Client Audit — Point Zero</h1>
          <p className="text-xs text-muted-foreground">{reviewed} / {total} reviewed</p>
        </div>
        <div className="flex-1 max-w-xs">
          <div className="w-full bg-zinc-100 rounded-full h-2">
            <div
              className="bg-emerald-500 h-2 rounded-full transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{pct}% complete</p>
        </div>
        {/* Who is reviewing */}
        <div className="flex items-center gap-2 ml-auto">
          <User className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Reviewing as:</span>
          <div className="flex gap-1">
            {REVIEWERS.map(r => (
              <button
                key={r}
                onClick={() => setReviewer(r)}
                className={cn(
                  'px-2.5 py-1 text-xs rounded-md border transition-colors',
                  reviewer === r
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left pane */}
        <div className="w-72 border-r bg-white flex flex-col shrink-0">
          {/* Search */}
          <div className="p-3 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search company..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Show filter */}
          <div className="px-3 pt-2 pb-1 flex gap-1 flex-wrap">
            {(['all', 'unreviewed', 'reviewed', 'flagged'] as ShowFilter[]).map(f => (
              <button
                key={f}
                onClick={() => setShowFilter(f)}
                className={cn(
                  'px-2 py-0.5 text-xs rounded-full border transition-colors',
                  showFilter === f
                    ? 'bg-zinc-800 text-white border-zinc-800'
                    : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'
                )}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {/* Status filter */}
          <div className="px-3 pb-2 flex gap-1 flex-wrap border-b">
            {(['all', 'Active', 'Delinquent', 'Offboarding', 'Suspended'] as StatusFilter[]).map(f => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={cn(
                  'px-2 py-0.5 text-xs rounded-full border transition-colors',
                  statusFilter === f
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'
                )}
              >
                {f}
              </button>
            ))}
          </div>

          {/* Account list */}
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="p-4 text-sm text-muted-foreground text-center">No accounts match filters</div>
            )}
            {filtered.map((account, idx) => (
              <button
                key={account.id}
                onClick={() => setSelectedId(account.id)}
                className={cn(
                  'w-full text-left px-3 py-2.5 border-b border-zinc-100 hover:bg-zinc-50 transition-colors',
                  selectedId === account.id && 'bg-blue-50 border-l-2 border-l-blue-500'
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-400 w-6 shrink-0">{idx + 1}</span>
                  <span className="flex-1 text-sm font-medium truncate">{account.company_name}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    {account.anomaly_score > 0 && !account.audit_reviewed_at && (
                      <span className="text-xs text-amber-500 font-medium">!</span>
                    )}
                    {account.audit_flag && <Flag className="h-3 w-3 text-amber-500" />}
                    {account.audit_reviewed_at
                      ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                      : <Clock className="h-3.5 w-3.5 text-zinc-300" />
                    }
                  </div>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5 pl-6">
                  <span className={cn(
                    'text-xs px-1.5 py-0 rounded-full',
                    account.status === 'Active' && 'bg-emerald-100 text-emerald-700',
                    account.status === 'Delinquent' && 'bg-red-100 text-red-700',
                    account.status === 'Offboarding' && 'bg-amber-100 text-amber-700',
                    !['Active', 'Delinquent', 'Offboarding'].includes(account.status ?? '') && 'bg-zinc-100 text-zinc-600',
                  )}>
                    {account.status}
                  </span>
                  {!account.onboarding_date && (
                    <span className="text-xs text-amber-600 flex items-center gap-0.5">
                      <AlertCircle className="h-2.5 w-2.5" /> No start date
                    </span>
                  )}
                </div>
                {account.audit_reviewed_at && (
                  <p className="text-xs text-muted-foreground mt-0.5 pl-6">
                    {account.audit_reviewed_by && `${account.audit_reviewed_by} · `}
                    {format(parseISO(account.audit_reviewed_at), 'MMM d')}
                  </p>
                )}
              </button>
            ))}
          </div>

          <div className="px-3 py-2 border-t text-xs text-muted-foreground">
            {filtered.length} of {total} accounts
          </div>
        </div>

        {/* Right pane */}
        <div className="flex-1 overflow-y-auto bg-zinc-50">
          {selected ? (
            <AuditPanel
              key={selected.id}
              account={selected}
              reviewer={reviewer}
              position={{ current: selectedIndex + 1, total: filtered.length }}
              onUpdated={handleAccountUpdated}
              onNext={goNext}
              onPrev={goPrev}
              hasPrev={selectedIndex > 0}
              hasNext={selectedIndex < filtered.length - 1}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              Select an account to audit
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
