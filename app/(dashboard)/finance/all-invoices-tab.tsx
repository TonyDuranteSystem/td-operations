'use client'

import { useState, useMemo, useTransition, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { format, parseISO } from 'date-fns'
import {
  Search, FileText, Send, CheckCircle, Edit3, X, Plus,
  ChevronDown, ChevronUp, Building2, User, Ban, Loader2, Unlink, RefreshCw, Bell,
} from 'lucide-react'
import { toast } from 'sonner'
import { markInvoicePaid, voidInvoice, voidInvoicePreview, sendInvoiceReminder, sendNewInvoice, updateInvoice, createUnifiedInvoiceDraft, unlinkPayment, sendBulkReminders } from './actions'
import { regenerateInvoice } from '@/app/(dashboard)/payments/invoice-actions'
import { InvoiceDialog } from '@/components/payments/invoice-dialog'
import { InvoiceNoteDot } from '@/components/payments/invoice-note-dot'
import { isAccountReminderPaused } from '@/lib/billing/reminder-snooze'
import { ConfirmDestructiveDialog } from '@/components/ui/confirm-destructive-dialog'

const STATUS_COLORS: Record<string, string> = {
  Paid: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700',
  Sent: 'bg-blue-100 text-blue-700',
  Draft: 'bg-zinc-100 text-zinc-600',
  Partial: 'bg-orange-100 text-orange-700',
}

const STATUS_FILTERS = ['All', 'Overdue', 'Sent', 'Paid', 'Partial', 'Draft'] as const

type SortField = 'invoice_number' | 'client' | 'total' | 'status' | 'issue_date' | 'due_date'
type SortDir = 'asc' | 'desc'

export interface InvoiceRecord {
  id: string
  invoice_number: string
  status: string
  total: number
  amount_paid: number
  amount_due: number
  currency: string
  issue_date: string | null
  due_date: string | null
  paid_date: string | null
  notes: string | null
  description: string | null
  account_id: string | null
  contact_id: string | null
  reminder_count?: number
  last_reminder_at?: string | null
  reminders_auto?: number
  reminders_manual?: number
  accounts: { company_name: string; dunning_pause?: boolean | null; dunning_pause_until?: string | null } | null
  contacts: { full_name: string } | null
}

/** Reminders paused for this invoice's client (boolean or active dated pause)? */
function isPaused(inv: InvoiceRecord): boolean {
  return isAccountReminderPaused(inv.accounts)
}

function formatCurrency(amount: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount)
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—'
  try {
    return format(parseISO(dateStr), 'MMM d, yyyy')
  } catch {
    return '—'
  }
}

function getClientName(inv: InvoiceRecord): string {
  return inv.accounts?.company_name ?? inv.contacts?.full_name ?? '—'
}

/** Hover detail for the reminder badge: auto vs manual breakdown + last sent. */
function reminderTooltip(inv: InvoiceRecord): string {
  const auto = inv.reminders_auto ?? 0
  const manual = inv.reminders_manual ?? 0
  const parts: string[] = []
  if (auto || manual) parts.push(`${auto} automatic, ${manual} manual`)
  if (inv.last_reminder_at) parts.push(`last sent ${formatDate(inv.last_reminder_at)}`)
  return parts.length ? `Reminders — ${parts.join(' · ')}` : 'Reminders sent'
}

/** Statuses for which a reminder can be sent (and thus bulk-selected). */
const REMINDABLE_STATUSES = new Set(['Sent', 'Overdue', 'Partial'])

export function AllInvoicesTab({ invoices, isAdmin = false }: { invoices: InvoiceRecord[]; isAdmin?: boolean }) {
  const [search, setSearch] = useState('')
  const [showNewInvoice, setShowNewInvoice] = useState(false)
  const [dialogMode, setDialogMode] = useState<'invoice' | 'credit'>('invoice')
  const newInvRouter = useRouter()
  const [statusFilter, setStatusFilter] = useState<string>('All')
  const [sortField, setSortField] = useState<SortField>('issue_date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // ── Bulk reminder selection (Phase 3) ──
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [overrideCap, setOverrideCap] = useState(false)
  const [bulkSending, setBulkSending] = useState(false)

  function toggleSelected(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleBulkRemind() {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    // Pre-send review warnings (the KG Wolf incident, 2026-07-03): surface
    // internal notes and paused clients BEFORE the emails go out.
    const selectedInvoices = invoices.filter(i => selected.has(i.id))
    const noted = selectedInvoices.filter(i => i.notes?.trim())
    const pausedCount = selectedInvoices.filter(i => isPaused(i)).length
    const notedList = noted.slice(0, 8).map(i => i.invoice_number).join(', ')
    if (!window.confirm(
      `Send a payment reminder to ${ids.length} invoice${ids.length > 1 ? 's' : ''}?` +
      (noted.length > 0 ? `\n\n⚠ ${noted.length} of them ${noted.length === 1 ? 'has' : 'have'} an internal note — review before sending (hover the 📝 icon): ${notedList}${noted.length > 8 ? ', …' : ''}` : '') +
      (pausedCount > 0 ? `\n\n⏸ ${pausedCount} belong to clients with reminders paused — those are skipped automatically.` : '') +
      (overrideCap ? '\n\nIncluding invoices already at the 2-reminder limit.' : '')
    )) return
    setBulkSending(true)
    try {
      const res = await sendBulkReminders(ids, { overrideCap })
      if (!res.success || !res.data) { toast.error(res.error ?? 'Bulk reminder failed'); return }
      const { sent, skipped, failed, outcomes } = res.data
      toast.success(`Reminders — ${sent} sent · ${skipped} skipped · ${failed} failed`)
      // Surface each non-sent outcome individually (R099: never hide the cause).
      outcomes.filter(o => o.status !== 'sent').slice(0, 10).forEach(o =>
        toast(`${o.invoice_number}: ${o.status} — ${o.reason ?? ''}`, { duration: 7000 }))
      setSelected(new Set())
      newInvRouter.refresh()
    } finally {
      setBulkSending(false)
    }
  }

  // ── Automatic-reminder (dunning) controls — admin only ──
  const [autoSend, setAutoSend] = useState<boolean | null>(null)
  const [cap, setCap] = useState<number>(40)
  const [capDraft, setCapDraft] = useState<string>('40')
  const [autoSaving, setAutoSaving] = useState(false)
  const [dunningRunning, setDunningRunning] = useState(false)

  const CAP_MAX = 1000
  function normalizeCap(n: unknown): number {
    const v = Math.floor(Number(n))
    if (!Number.isFinite(v) || v < 1) return 40
    return Math.min(v, CAP_MAX)
  }

  useEffect(() => {
    if (!isAdmin) return
    fetch('/api/app-settings?key=dunning_autosend')
      .then(r => r.json())
      .then(d => {
        setAutoSend(d?.value?.enabled === true)
        const c = d?.value?.cap == null ? 40 : normalizeCap(d.value.cap)
        setCap(c); setCapDraft(String(c))
      })
      .catch(() => { setAutoSend(false); setCap(40); setCapDraft('40') })
  }, [isAdmin])

  // Write the full dunning_autosend value (enabled + cap) so neither control
  // clobbers the other.
  async function saveDunning(next: { enabled: boolean; cap: number }) {
    const res = await fetch('/api/app-settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'dunning_autosend', value: next }),
    })
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error ?? 'Failed to update') }
  }

  async function toggleAutoSend() {
    const next = !(autoSend ?? false)
    if (next && !window.confirm(`Turn ON automatic reminders?\n\nThe daily job (9:00) will start emailing overdue clients — 1st reminder at 7 days overdue, 2nd at 14 — up to ${cap} per run.`)) return
    setAutoSaving(true)
    setAutoSend(next)
    try {
      await saveDunning({ enabled: next, cap })
      toast.success(next ? 'Automatic reminders turned ON' : 'Automatic reminders turned OFF')
    } catch (err) {
      setAutoSend(!next)
      toast.error(err instanceof Error ? err.message : 'Failed to update')
    } finally { setAutoSaving(false) }
  }

  async function saveCap() {
    const newCap = normalizeCap(capDraft)
    if (newCap === cap) { setCapDraft(String(cap)); return }
    setAutoSaving(true)
    const prev = cap
    setCap(newCap); setCapDraft(String(newCap))
    try {
      await saveDunning({ enabled: autoSend ?? false, cap: newCap })
      toast.success(`Per-run limit set to ${newCap}`)
    } catch (err) {
      setCap(prev); setCapDraft(String(prev))
      toast.error(err instanceof Error ? err.message : 'Failed to update')
    } finally { setAutoSaving(false) }
  }

  async function runDunningNow() {
    if (!window.confirm(`Run reminders now?\n\nQueues a reminder for every due overdue invoice (up to ${cap} this pass), respecting each client's timing, pause, and the 2-reminder limit. They send gradually in the background over the next several minutes.`)) return
    setDunningRunning(true)
    try {
      const res = await fetch('/api/invoices/run-dunning', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(d.error ?? 'Failed to run reminders'); return }
      toast.success(`Queued ${d.reminders_queued ?? 0} reminder${(d.reminders_queued ?? 0) === 1 ? '' : 's'} · ${d.skipped ?? 0} already queued · ${d.marked_overdue ?? 0} newly overdue${d.capped ? ` · ${cap}-cap hit, run again for the rest` : ''}. They send gradually in the background.`)
      newInvRouter.refresh()
    } finally { setDunningRunning(false) }
  }

  // Counts per status
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { All: invoices.length }
    for (const inv of invoices) {
      counts[inv.status] = (counts[inv.status] ?? 0) + 1
    }
    return counts
  }, [invoices])

  // Summary stats
  const summaryStats = useMemo(() => {
    let outstanding = 0
    let overdueAmount = 0
    let overdueCount = 0
    for (const inv of invoices) {
      if (['Sent', 'Overdue', 'Partial'].includes(inv.status)) {
        outstanding += Number(inv.amount_due ?? inv.total ?? 0)
      }
      if (inv.status === 'Overdue') {
        overdueAmount += Number(inv.amount_due ?? inv.total ?? 0)
        overdueCount++
      }
    }
    return { total: invoices.length, outstanding, overdueAmount, overdueCount }
  }, [invoices])

  // Filter + search + sort
  const filtered = useMemo(() => {
    let list = invoices

    // Status filter
    if (statusFilter !== 'All') {
      list = list.filter(inv => inv.status === statusFilter)
    }

    // Search
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(inv =>
        inv.invoice_number?.toLowerCase().includes(q) ||
        getClientName(inv).toLowerCase().includes(q) ||
        inv.notes?.toLowerCase().includes(q)
      )
    }

    // Sort
    list = [...list].sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'invoice_number':
          cmp = (a.invoice_number ?? '').localeCompare(b.invoice_number ?? '')
          break
        case 'client':
          cmp = getClientName(a).localeCompare(getClientName(b))
          break
        case 'total':
          cmp = Number(a.total ?? 0) - Number(b.total ?? 0)
          break
        case 'status':
          cmp = (a.status ?? '').localeCompare(b.status ?? '')
          break
        case 'issue_date':
          cmp = (a.issue_date ?? '').localeCompare(b.issue_date ?? '')
          break
        case 'due_date': {
          const aDate = a.paid_date ?? a.due_date ?? ''
          const bDate = b.paid_date ?? b.due_date ?? ''
          cmp = aDate.localeCompare(bDate)
          break
        }
      }
      // Stable tiebreak by id so equal sort keys (e.g. same issue_date) keep a
      // fixed order across refreshes — fixes "the list reorders and I lose my
      // place" when chasing overdue invoices (dev_task d2af38a1).
      if (cmp === 0) cmp = (a.id ?? '').localeCompare(b.id ?? '')
      return sortDir === 'asc' ? cmp : -cmp
    })

    return list
  }, [invoices, statusFilter, search, sortField, sortDir])

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return null
    return sortDir === 'asc'
      ? <ChevronUp className="w-3 h-3 inline ml-1" />
      : <ChevronDown className="w-3 h-3 inline ml-1" />
  }

  return (
    <div className="p-6 space-y-4">
      {/* Automatic-reminder (dunning) controls — admin only */}
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/40 px-4 py-2.5 text-sm">
          <Bell className="w-4 h-4 text-amber-600" />
          <span className="font-medium text-foreground">Automatic reminders</span>
          <button
            onClick={toggleAutoSend}
            disabled={autoSend === null || autoSaving}
            className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-colors disabled:opacity-50 ${
              autoSend ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-zinc-200 text-zinc-600 hover:bg-zinc-300'
            }`}
            title="Turn the daily automatic reminder schedule on or off"
          >
            {autoSend === null ? '…' : autoSend ? 'ON' : 'OFF'}
          </button>
          <span className="text-xs text-muted-foreground">Daily 9:00 · 1st at 7d overdue, 2nd at 14d · sends gradually in the background</span>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`Max reminders queued per pass (1–${CAP_MAX}). The rest roll to the next pass; all send gradually in the background.`}>
            Max per run
            <input
              type="number" min={1} max={CAP_MAX}
              value={capDraft}
              onChange={e => setCapDraft(e.target.value)}
              onBlur={saveCap}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              disabled={autoSaving}
              className="w-16 px-2 py-1 border rounded-md text-xs text-foreground disabled:opacity-50"
            />
          </label>
          <button
            onClick={runDunningNow}
            disabled={dunningRunning}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white text-xs font-medium rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50"
            title={`Run the reminder job right now (sends all that are due, up to ${cap})`}
          >
            {dunningRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Run reminders now
          </button>
        </div>
      )}

      {/* Summary bar */}
      <div className="flex items-center gap-6 text-sm text-muted-foreground bg-muted/50 rounded-lg px-4 py-3">
        <span>Total: <strong className="text-foreground">{summaryStats.total}</strong> invoices</span>
        <span>Outstanding: <strong className="text-foreground">{formatCurrency(summaryStats.outstanding)}</strong></span>
        {summaryStats.overdueCount > 0 && (
          <span className="text-red-600">
            Overdue: <strong>{formatCurrency(summaryStats.overdueAmount)}</strong> ({summaryStats.overdueCount} invoices)
          </span>
        )}
        <button
          onClick={() => { setDialogMode('invoice'); setShowNewInvoice(true) }}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          New Invoice
        </button>
        <button
          onClick={() => { setDialogMode('credit'); setShowNewInvoice(true) }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 text-white text-xs font-medium rounded-lg hover:bg-purple-700 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          New Credit Note
        </button>
      </div>

      {/* Search + status filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by invoice #, client, or description..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          {STATUS_FILTERS.map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                statusFilter === s
                  ? 'bg-blue-600 text-white'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              {s} {statusCounts[s] != null ? `(${statusCounts[s]})` : '(0)'}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk reminder toolbar — appears when invoices are selected */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm">
          <span className="font-medium text-amber-800">{selected.size} selected</span>
          <label className="flex items-center gap-1.5 text-amber-800 cursor-pointer">
            <input type="checkbox" checked={overrideCap} onChange={e => setOverrideCap(e.target.checked)} />
            Send even if already at the 2-reminder limit
          </label>
          <button
            onClick={handleBulkRemind}
            disabled={bulkSending}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 text-white text-xs font-medium rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50"
          >
            {bulkSending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            Send Reminders ({selected.size})
          </button>
          <button onClick={() => setSelected(new Set())} className="text-amber-700 hover:text-amber-900 text-xs">Clear</button>
        </div>
      )}

      {/* Table */}
      <div className="border rounded-lg overflow-auto max-h-[calc(100vh-320px)]">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 sticky top-0">
            <tr>
              <th className="w-8 px-3 py-3">
                {(() => {
                  const selectable = filtered.filter(i => REMINDABLE_STATUSES.has(i.status))
                  const allSel = selectable.length > 0 && selectable.every(i => selected.has(i.id))
                  return (
                    <input
                      type="checkbox"
                      aria-label="Select all remindable invoices"
                      checked={allSel}
                      onChange={e => {
                        setSelected(prev => {
                          const next = new Set(prev)
                          if (e.target.checked) selectable.forEach(i => next.add(i.id))
                          else selectable.forEach(i => next.delete(i.id))
                          return next
                        })
                      }}
                    />
                  )
                })()}
              </th>
              <th className="text-left px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('invoice_number')}>
                Invoice # <SortIcon field="invoice_number" />
              </th>
              <th className="text-left px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('client')}>
                Client <SortIcon field="client" />
              </th>
              <th className="text-left px-4 py-3 font-medium">Description</th>
              <th className="text-right px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('total')}>
                Amount <SortIcon field="total" />
              </th>
              <th className="text-left px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('status')}>
                Status <SortIcon field="status" />
              </th>
              <th className="text-left px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('issue_date')}>
                Issue Date <SortIcon field="issue_date" />
              </th>
              <th className="text-left px-4 py-3 font-medium cursor-pointer select-none" onClick={() => toggleSort('due_date')}>
                Due / Paid <SortIcon field="due_date" />
              </th>
              <th className="text-center px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="text-center py-12 text-muted-foreground">
                  <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  No invoices found
                </td>
              </tr>
            )}
            {filtered.map(inv => {
              const isOverdue = inv.status === 'Overdue'
              const clientName = getClientName(inv)
              const hasAccount = !!inv.accounts?.company_name

              return (
                <tr
                  key={inv.id}
                  className={`hover:bg-muted/30 transition-colors ${isOverdue ? 'bg-red-50/50' : ''}`}
                >
                  <td className="w-8 px-3 py-3">
                    {REMINDABLE_STATUSES.has(inv.status) && (
                      <input
                        type="checkbox"
                        aria-label={`Select invoice ${inv.invoice_number}`}
                        checked={selected.has(inv.id)}
                        onChange={() => toggleSelected(inv.id)}
                      />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={`/api/invoices/${inv.id}/pdf`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-blue-600 text-xs hover:underline"
                      title="Open invoice PDF"
                    >
                      {inv.invoice_number}
                    </a>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {hasAccount
                        ? <Building2 className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                        : <User className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      }
                      <span className="truncate max-w-[200px]">{clientName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <span className="truncate block max-w-[200px]" title={inv.description ?? ''}>
                      {inv.description ? (inv.description.length > 60 ? inv.description.slice(0, 60) + '...' : inv.description) : '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    {formatCurrency(Number(inv.total ?? 0), inv.currency || 'USD')}
                    {inv.status === 'Partial' && inv.amount_paid > 0 && (
                      <div className="text-xs text-emerald-600">
                        {formatCurrency(Number(inv.amount_paid), inv.currency || 'USD')} paid
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[inv.status] ?? 'bg-zinc-100 text-zinc-600'}`}>
                      {inv.status}
                    </span>
                    <InvoiceNoteDot note={inv.notes} className="ml-1" />
                    {isPaused(inv) && (
                      <div
                        className="mt-1 text-[11px] text-violet-600 whitespace-nowrap cursor-default"
                        title={inv.accounts?.dunning_pause_until
                          ? `Payment reminders are paused for this client until ${formatDate(inv.accounts.dunning_pause_until)} — set in the account's Payment Reminder Settings`
                          : 'Payment reminders are paused for this client — set in the account\'s Payment Reminder Settings'}
                      >
                        ⏸ Paused{inv.accounts?.dunning_pause_until ? ` until ${formatDate(inv.accounts.dunning_pause_until)}` : ''}
                      </div>
                    )}
                    {(inv.reminder_count ?? 0) > 0 && (
                      <div
                        className="mt-1 text-[11px] text-amber-600 whitespace-nowrap cursor-default"
                        title={reminderTooltip(inv)}
                      >
                        🔔 {inv.reminder_count} {inv.reminder_count === 1 ? 'reminder' : 'reminders'}
                        {inv.last_reminder_at ? ` · ${formatDate(inv.last_reminder_at)}` : ''}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground tabular-nums">
                    {formatDate(inv.issue_date)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground tabular-nums">
                    {inv.status === 'Paid' ? formatDate(inv.paid_date) : formatDate(inv.due_date)}
                  </td>
                  <td className="px-4 py-3">
                    <InvoiceActions invoice={inv} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Footer count */}
      <div className="text-xs text-muted-foreground text-right">
        Showing {filtered.length} of {invoices.length} invoices
      </div>

      {/* New Invoice / Credit Note Dialog */}
      <InvoiceDialog
        open={showNewInvoice}
        mode={dialogMode}
        onClose={() => {
          setShowNewInvoice(false)
          newInvRouter.refresh()
        }}
        onCreateInvoice={async (input) => {
          const result = await createUnifiedInvoiceDraft({
            account_id: input.account_id,
            description: input.description,
            currency: (input.amount_currency || 'USD') as 'USD' | 'EUR',
            due_date: input.due_date,
            message: input.message,
            payment_method: input.payment_method,
            bank_preference: input.bank_preference,
            items: input.items,
            mark_as_paid: input.mark_as_paid,
          })
          return result
        }}
        onSendInvoice={async (paymentId) => {
          return await sendNewInvoice(paymentId)
        }}
      />
    </div>
  )
}

// ── Invoice Action Buttons ──

// ── Styled Tooltip Button ──

function ActionButton({ onClick, label, icon: Icon, color, hoverBg }: {
  onClick?: () => void; label: string; icon: typeof CheckCircle; color: string; hoverBg: string
}) {
  return (
    <div className="relative group">
      <button onClick={onClick} className={`p-1.5 rounded-md ${hoverBg} ${color} transition-colors`}>
        <Icon className="w-4 h-4" />
      </button>
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 bg-zinc-900 text-white text-[10px] rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
        {label}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-zinc-900" />
      </div>
    </div>
  )
}

// ── Invoice Actions ──

function InvoiceActions({ invoice }: { invoice: InvoiceRecord }) {
  const [isPending, startTransition] = useTransition()
  const [editing, setEditing] = useState(false)
  const [voidDialogOpen, setVoidDialogOpen] = useState(false)
  const router = useRouter()
  const { id: invoiceId, invoice_number: invoiceNumber, status } = invoice

  const handleMarkPaid = () => {
    if (!window.confirm(`Mark ${invoiceNumber} as Paid?`)) return
    startTransition(async () => {
      const result = await markInvoicePaid(invoiceId)
      if (result.success) { toast.success(`${invoiceNumber} marked as Paid`); router.refresh() }
      else toast.error(result.error ?? 'Failed')
    })
  }

  const handleSendDraft = () => {
    // First send of a Draft invoice — same backend as the By Client tab's Send
    // button (sendNewInvoice → sendTDInvoice: PDF + HTML email, sets Sent).
    if (!window.confirm(`Send invoice ${invoiceNumber} to the client with PDF attached?`)) return
    startTransition(async () => {
      const result = await sendNewInvoice(invoiceId)
      if (result.success) { toast.success(`Invoice ${invoiceNumber} sent to client`); router.refresh() }
      else toast.error(result.error ?? 'Failed to send')
    })
  }

  const handleResendInvoice = () => {
    if (!window.confirm(`Resend invoice ${invoiceNumber} with PDF to the client?`)) return
    startTransition(async () => {
      const res = await fetch(`/api/invoices/${invoiceId}/send`, { method: 'POST' })
      const data = await res.json().catch(() => ({} as { success?: boolean; error?: string }))
      if (data.success) { toast.success(`Invoice ${invoiceNumber} resent with PDF`); router.refresh() }
      else toast.error(data.error ?? 'Failed to resend')
    })
  }

  const handleSendReminder = () => {
    // Paused client → explicit warn-and-confirm, then a deliberate force-send.
    const paused = isPaused(invoice)
    const until = invoice.accounts?.dunning_pause_until
    const prompt = paused
      ? `⏸ Payment reminders are PAUSED for this client${until ? ` until ${formatDate(until)}` : ''}${invoice.notes?.trim() ? `\n\nInternal note: ${invoice.notes.trim()}` : ''}\n\nSend the reminder for ${invoiceNumber} anyway?`
      : `Send payment reminder for ${invoiceNumber}?`
    if (!window.confirm(prompt)) return
    startTransition(async () => {
      const result = await sendInvoiceReminder(invoiceId, { force: paused })
      if (result.success) { toast.success(`Reminder sent for ${invoiceNumber}`); router.refresh() }
      else toast.error(result.error ?? 'Failed')
    })
  }

  const handleRegenerate = () => {
    startTransition(async () => {
      const result = await regenerateInvoice(invoiceId)
      if (!result.success) { toast.error(result.error ?? 'Failed to regenerate'); return }
      const applied = (result.data?.applied_credit as number) ?? 0
      if (applied > 0) { toast.success(`${invoiceNumber} regenerated — applied credit now shown as a line`); router.refresh() }
      else toast.info('No available credit to apply to this invoice')
    })
  }

  const handleVoid = () => setVoidDialogOpen(true)

  const handleVoidConfirm = async () => {
    const result = await voidInvoice(invoiceId)
    if (result.success) {
      router.refresh()
      return { success: true, message: `${invoiceNumber} voided` }
    }
    return { success: false, error: result.error ?? 'Failed' }
  }

  const loadVoidPreview = async () => {
    const r = await voidInvoicePreview(invoiceId)
    if (!r.success || !r.preview) {
      throw new Error(r.error ?? 'Preview unavailable')
    }
    return r.preview
  }

  if (isPending) {
    return <div className="flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>
  }

  return (
    <>
      <div className="flex items-center justify-center gap-0.5">
        {status === 'Draft' && (
          <ActionButton onClick={handleSendDraft} label="Send Invoice — email the invoice with PDF to the client (Draft → Sent)" icon={Send} color="text-blue-600" hoverBg="hover:bg-blue-100" />
        )}
        {status !== 'Paid' && status !== 'Cancelled' && (
          <ActionButton onClick={handleMarkPaid} label="Mark as Paid — record this invoice as paid manually" icon={CheckCircle} color="text-emerald-600" hoverBg="hover:bg-emerald-100" />
        )}
        {['Sent', 'Overdue', 'Partial'].includes(status) && (
          <ActionButton onClick={handleResendInvoice} label="Resend Invoice — send the full invoice email with PDF attached to the client" icon={FileText} color="text-blue-600" hoverBg="hover:bg-blue-100" />
        )}
        {['Sent', 'Overdue', 'Partial'].includes(status) && (
          <ActionButton onClick={handleSendReminder} label="Send Reminder — send a short payment reminder email (no PDF)" icon={Send} color="text-sky-600" hoverBg="hover:bg-sky-100" />
        )}
        {status !== 'Paid' && status !== 'Cancelled' && (
          <ActionButton onClick={handleVoid} label="Void Invoice — cancel this invoice and reverse any applied credits" icon={Ban} color="text-red-500" hoverBg="hover:bg-red-100" />
        )}
        {['Draft', 'Sent', 'Overdue', 'Partial'].includes(status) && (
          <ActionButton onClick={handleRegenerate} label="Regenerate — recalculate and apply any available credit notes" icon={RefreshCw} color="text-indigo-600" hoverBg="hover:bg-indigo-100" />
        )}
        <ActionButton onClick={() => setEditing(true)} label="Edit — change amount, due date, notes, or payment terms" icon={Edit3} color="text-zinc-500" hoverBg="hover:bg-zinc-100" />
        {status === 'Paid' && (
          <ActionButton
            onClick={() => {
              if (!window.confirm(`Unlink payment from ${invoiceNumber}? The invoice will revert to Draft and the bank feed entry will be reset to pending.`)) return
              startTransition(async () => {
                const result = await unlinkPayment(invoiceId)
                if (result.success) { toast.success(`${invoiceNumber} unlinked — reverted to Draft`); router.refresh() }
                else toast.error(result.error ?? 'Failed to unlink')
              })
            }}
            label="Unlink Payment — detach the payment from this invoice and revert to Draft"
            icon={Unlink}
            color="text-orange-600"
            hoverBg="hover:bg-orange-100"
          />
        )}
      </div>
      {editing && (
        <EditInvoiceDialog invoice={invoice} onClose={() => setEditing(false)} />
      )}
      <ConfirmDestructiveDialog
        open={voidDialogOpen}
        onClose={() => setVoidDialogOpen(false)}
        title="Void Invoice"
        description={`Void invoice ${invoiceNumber}?`}
        severity="red"
        loadPreview={loadVoidPreview}
        confirmLabel="Void Invoice"
        onConfirm={handleVoidConfirm}
      />
    </>
  )
}

// ── Edit Invoice Dialog ──

function EditInvoiceDialog({ invoice, onClose }: { invoice: InvoiceRecord; onClose: () => void }) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const [dueDate, setDueDate] = useState(invoice.due_date ?? '')
  const [notes, setNotes] = useState(invoice.notes ?? '')
  const [message, setMessage] = useState((invoice as unknown as Record<string, string>).message ?? '')
  const [total, setTotal] = useState(String(invoice.total ?? 0))

  const handleSave = () => {
    startTransition(async () => {
      const updates: Record<string, unknown> = {}
      if (dueDate !== (invoice.due_date ?? '')) updates.due_date = dueDate
      if (notes !== (invoice.notes ?? '')) updates.notes = notes
      if (message !== ((invoice as unknown as Record<string, string>).message ?? '')) updates.message = message
      const newTotal = parseFloat(total)
      if (!isNaN(newTotal) && newTotal !== Number(invoice.total)) updates.total = newTotal

      if (Object.keys(updates).length === 0) { onClose(); return }

      const result = await updateInvoice(invoice.id, updates as { due_date?: string; notes?: string; message?: string; total?: number })
      if (result.success) {
        toast.success(`${invoice.invoice_number} updated`)
        router.refresh()
        onClose()
      } else {
        toast.error(result.error ?? 'Failed to update')
      }
    })
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">Edit {invoice.invoice_number}</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Client</label>
            <p className="text-sm font-medium">
              {(invoice.accounts as unknown as { company_name: string })?.company_name
                ?? (invoice.contacts as unknown as { full_name: string })?.full_name
                ?? '—'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Amount ({invoice.currency || 'USD'})</label>
              <input
                type="number"
                step="0.01"
                value={total}
                onChange={e => setTotal(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Due Date</label>
              <input
                type="date"
                value={dueDate}
                onChange={e => setDueDate(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Payment Terms <span className="text-amber-600">(visible to client in portal)</span></label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="Payment terms visible to client (e.g. 'Net 30', 'Due upon receipt')"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1">Internal Notes</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="Internal notes (not visible to client)"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border hover:bg-zinc-50">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={isPending}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {isPending && <Loader2 className="w-3 h-3 animate-spin" />}
            Save Changes
          </button>
        </div>
      </div>
    </div>
  )
}
