'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { applyVendorRulesTo, normalizeVendorKey, type VendorRule } from '@/lib/owner-vendor-match'
import type { OwnerTransaction, OwnerCategory } from '@/lib/owner-finance'
import { FastTooltip } from '@/components/ui/fast-tooltip'

const CATEGORIES: OwnerCategory[] = ['income', 'cogs', 'expense', 'distribution', 'contribution', 'transfer', 'fee', 'conversion', 'refund', 'uncategorized']

const CATEGORY_LABELS: Record<string, string> = {
  income: 'Other Income',
  cogs: 'Cost of Goods (COGS)',
  expense: 'Operating Expense',
  distribution: 'Owner Distribution',
  contribution: 'Owner Contribution',
  // Vendor-NEUTRAL on purpose (Antonio, 2026-08-30): this used to read
  // "Stripe payout". A payout from ANY processor into a bank account is the same
  // accounting event — money moving between accounts the company already owns —
  // so naming one provider in the label ages badly the day the processor changes.
  // The stored value has always been the generic 'transfer'; only wording changed.
  transfer: 'Transfer (between your own accounts, incl. processor payouts)',
  fee: 'Bank / Processing Fee',
  conversion: 'Currency Conversion',
  refund: 'Refund',
  uncategorized: 'Uncategorized',
}

const SUBCATEGORIES: Record<string, { value: string; label: string }[]> = {
  income: [
    { value: 'consulting', label: 'Consulting' },
    { value: 'tax_services', label: 'Tax Services' },
    { value: 'formation', label: 'Formation' },
    { value: 'renewal', label: 'Renewal' },
    { value: 'sales', label: 'Sales' },
    { value: 'services', label: 'Services' },
    { value: 'general', label: 'General Income' },
    { value: 'other_income', label: 'Other Income' },
  ],
  cogs: [
    { value: 'contractor', label: 'Contractor' },
    { value: 'payroll', label: 'Payroll' },
    { value: 'subcontractor', label: 'Subcontractor' },
  ],
  expense: [
    { value: 'accounting', label: 'Accounting' },
    { value: 'advertising', label: 'Advertising & Promotion' },
    { value: 'bank_fees', label: 'Bank Fees' },
    { value: 'education', label: 'Education' },
    { value: 'equipment', label: 'Equipment' },
    { value: 'insurance', label: 'Insurance' },
    { value: 'interest', label: 'Interest' },
    { value: 'janitorial', label: 'Janitorial' },
    { value: 'legal', label: 'Legal' },
    { value: 'marketing', label: 'Marketing / Website Ads' },
    { value: 'meals', label: 'Meals & Entertainment' },
    { value: 'office', label: 'Office Supplies' },
    { value: 'payment_fees', label: 'Payment Processing Fees' },
    { value: 'payroll', label: 'Payroll / Salaries' },
    { value: 'real_estate', label: 'Real Estate' },
    { value: 'recruitment', label: 'Recruitment' },
    { value: 'rent', label: 'Rent' },
    { value: 'repairs', label: 'Repairs & Maintenance' },
    { value: 'saas', label: 'SaaS / Subscriptions' },
    { value: 'shipping', label: 'Shipping & Postage' },
    { value: 'social_media', label: 'Social Media' },
    { value: 'software', label: 'Software & Apps' },
    { value: 'stripe_fees', label: 'Stripe Fees' },
    { value: 'tax', label: 'Tax Payments' },
    { value: 'travel', label: 'Travel' },
    { value: 'utilities', label: 'Utilities' },
    { value: 'vehicle', label: 'Vehicle' },
    { value: 'other_expense', label: 'Other Expense' },
  ],
  distribution: [
    { value: 'distribution', label: 'Owner Distribution' },
  ],
  contribution: [
    { value: 'contribution', label: 'Owner Contribution' },
  ],
  transfer: [
    { value: 'stripe_payout', label: 'Stripe Payout (clearing)' },
    { value: 'own_account', label: 'Between Own Bank Accounts' },
  ],
  fee: [
    { value: 'bank_fee', label: 'Bank Fee' },
    { value: 'processing_fee', label: 'Processing Fee' },
    { value: 'wire_fee', label: 'Wire Fee' },
  ],
  conversion: [
    { value: 'fx_conversion', label: 'FX Conversion' },
    { value: 'internal_transfer', label: 'Internal Transfer' },
  ],
  refund: [
    { value: 'client_refund', label: 'Client Refund' },
    { value: 'vendor_refund', label: 'Vendor Refund' },
  ],
  uncategorized: [],
}

/** Row amounts render in the ROW's currency — a €500 line must never display as $500. */
const fmtRow = (n: number, currency: string | null) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(Math.abs(n))

interface TransactionsTabProps {
  year: number
  initialRows: OwnerTransaction[]
  initialTotal: number
}

interface ModalState {
  tx: OwnerTransaction
  category: OwnerCategory
  subcategory: string
  notes: string
  /** "Transactions like this" (whole-year, server-computed). null = still loading. */
  similar: {
    count: number
    ids: string[]
    suggested_pattern: string
    preview: { text: string; amount: number }[]
    mixed_signs: boolean
    truncated: boolean
    has_positive_feed_rows: boolean
  } | null
  applyToAll: boolean
  saveRule: boolean
}

export function TransactionsTab({ year, initialRows, initialTotal }: TransactionsTabProps) {
  const [rows, setRows] = useState<OwnerTransaction[]>(initialRows)
  const [total, setTotal] = useState(initialTotal)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [filterCategory, setFilterCategory] = useState<OwnerCategory | ''>('uncategorized')
  const [offset, setOffset] = useState(0)
  const [modal, setModal] = useState<ModalState | null>(null)
  const [saving, setSaving] = useState(false)
  /** The row currently being sent back to Finance (disables just that button). */
  const [sendingRef, setSendingRef] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkCategory, setBulkCategory] = useState<OwnerCategory>('expense')
  const [bulkSubcategory, setBulkSubcategory] = useState('')
  const [rules, setRules] = useState<VendorRule[]>([])
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null)
  const LIMIT = 50

  const loadRules = useCallback(() => {
    fetch('/api/owner/vendor-rules')
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (data?.rules) setRules(data.rules) })
      .catch(() => { /* suggestions are an assist; the tab works without them */ })
  }, [])
  useEffect(() => { loadRules() }, [loadRules])

  /** Saved-rule SUGGESTIONS for uncategorized rows — shown as a chip the user confirms.
   * Nothing is ever auto-booked: a rule proposes, Antonio clicks. */
  const suggestionFor = useCallback((tx: OwnerTransaction): { category: OwnerCategory; subcategory: string | null; is_related_party: boolean } | null => {
    if (tx.category !== 'uncategorized' || rules.length === 0) return null
    const [applied] = applyVendorRulesTo([tx], rules)
    if (applied.category === 'uncategorized') return null
    return { category: applied.category as OwnerCategory, subcategory: applied.subcategory, is_related_party: applied.is_related_party }
  }, [rules])

  async function acceptSuggestion(tx: OwnerTransaction) {
    const s = suggestionFor(tx)
    if (!s) return
    // The double-count guard must cover EVERY apply surface, not just the modal: a bank
    // deposit chip-accepted as Income would silently double-count invoice money.
    if (s.category === 'income' && tx.amount > 0 && tx.transaction_ref?.startsWith('feed:')) {
      const ok = window.confirm(
        'This is a bank deposit. If it is a client paying an invoice, do NOT mark it Income — use "This is for a client →" instead, or the money will be counted twice. Mark as Income anyway (rewards/bonuses only)?'
      )
      if (!ok) return
    }
    try {
      const res = await fetch('/api/owner/transactions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tx.id, category: s.category, subcategory: s.subcategory, is_related_party: s.is_related_party }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Save failed') }
      toast.success('Suggestion applied')
      load(offset)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    }
  }

  const load = useCallback(async (newOffset = 0, cat = filterCategory, q = search) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ year: String(year), limit: String(LIMIT), offset: String(newOffset) })
      if (cat) params.set('category', cat)
      if (q) params.set('search', q)
      const res = await fetch(`/api/owner/transactions?${params}`)
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Load failed') }
      const data = await res.json()
      setRows(data.rows)
      setTotal(data.total)
      setOffset(newOffset)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Load failed')
    } finally {
      setLoading(false)
    }
  }, [year, filterCategory, search])

  /**
   * Re-fetch when the YEAR changes.
   *
   * The year <select> does a router.push, which re-renders the server component
   * and delivers fresh props — but this tab is NOT remounted, and `rows` was
   * seeded with useState(initialRows), which React does not re-initialise on a
   * prop change. Without this effect the previous year's rows stay on screen
   * under the new year's heading. Observed 2026-08-30: switching to 2025 kept all
   * 78 rows of 2026 data visible while the header read 2025.
   *
   * That is not merely cosmetic here. The modal, the bulk bar and "apply to all
   * like this" all act on the rows currently in state, so categorizing from a
   * stale list writes to the OTHER year's records while the page says otherwise —
   * which would break the hard rule that 2025 and 2026 stay separate.
   *
   * Deliberately calls load() rather than re-seeding from initialRows: the server
   * always fetches category='uncategorized', while this tab owns the live filter.
   * Re-seeding would silently drop the operator's chosen filter and show an
   * uncategorized-only list under a filter chip claiming something else.
   *
   * The ref skips the first run — on mount the server props ARE the current year,
   * and firing here would duplicate the initial fetch on every page load.
   */
  const seenYearRef = useRef(year)
  useEffect(() => {
    if (seenYearRef.current === year) return
    seenYearRef.current = year
    // Nothing from the previous year may survive into an action on this one.
    setSelected(new Set())
    setModal(null)
    setOffset(0)
    load(0)
  }, [year, load])

  function openModal(tx: OwnerTransaction) {
    setModal({ tx, category: tx.category, subcategory: tx.subcategory ?? '', notes: tx.notes ?? '', similar: null, applyToAll: false, saveRule: false })
    if (tx.category === 'uncategorized') {
      fetch(`/api/owner/transactions/similar?id=${tx.id}`)
        .then(r => (r.ok ? r.json() : null))
        .then(data => { if (data) setModal(m => m && m.tx.id === tx.id ? { ...m, similar: data } : m) })
        .catch(() => { /* the count is an assist; the modal works without it */ })
    }
  }

  async function saveModal() {
    if (!modal) return
    setSaving(true)
    try {
      const applyingToAll = modal.applyToAll && (modal.similar?.ids.length ?? 0) > 0
      let actuallyUpdated: number | null = null
      if (applyingToAll) {
        const res = await fetch('/api/owner/transactions/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // only_uncategorized: the id set was snapshotted at modal-open — a row
          // categorized meanwhile (other device/tab) must not be silently overwritten.
          body: JSON.stringify({ ids: [modal.tx.id, ...modal.similar!.ids], category: modal.category, subcategory: modal.subcategory || null, notes: modal.notes || null, only_uncategorized: true }),
        })
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Save failed') }
        const d = await res.json().catch(() => ({}))
        actuallyUpdated = typeof d.updated === 'number' ? d.updated : null
      } else {
        const res = await fetch('/api/owner/transactions', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: modal.tx.id, category: modal.category, subcategory: modal.subcategory || null, notes: modal.notes || null }),
        })
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Save failed') }
      }

      if (modal.saveRule && modal.subcategory) {
        // The pattern must cover the whole matched SET (shortest member), not the wording
        // of whichever row the modal opened on — a rule saved from the long Mercury
        // wording would never suggest on the short Relay wording again.
        const pattern = modal.similar?.suggested_pattern || normalizeVendorKey(modal.tx.counterparty ?? modal.tx.description)
        const res = await fetch('/api/owner/vendor-rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ counterparty_pattern: pattern, match_type: 'contains', category: modal.category, subcategory: modal.subcategory }),
        })
        if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error || 'Categorized, but the rule was not saved.') }
        else { loadRules() }
      } else if (modal.saveRule && !modal.subcategory) {
        toast.error('Rule not saved — pick a subcategory to save a rule.')
      }

      toast.success(
        applyingToAll
          ? actuallyUpdated !== null && actuallyUpdated < 1 + modal.similar!.ids.length
            ? `Categorized ${actuallyUpdated} transactions (${1 + modal.similar!.ids.length - actuallyUpdated} were already categorized elsewhere and kept their label)`
            : `Categorized ${actuallyUpdated ?? 1 + modal.similar!.ids.length} transactions`
          : 'Categorized'
      )
      setModal(null)
      load(offset)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  /**
   * "This is for a client" — the system put this here because it could not prove the money
   * was a client paying an invoice. Antonio knows better; this returns it to the Bank Feed
   * for matching (and removes it from his books so it can never be counted twice).
   */
  async function sendToFinance(tx: OwnerTransaction) {
    if (!tx.transaction_ref) return
    setSendingRef(tx.transaction_ref)
    try {
      const res = await fetch('/api/owner/transactions/to-finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_ref: tx.transaction_ref }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not move it to Finance.') }
      toast.success('Moved to Finance — it will be matched to an invoice')
      load(offset)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not move it to Finance.')
    } finally {
      setSendingRef(null)
    }
  }

  async function bulkCategorize() {
    if (selected.size === 0) return
    try {
      const res = await fetch('/api/owner/transactions/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selected), category: bulkCategory, subcategory: bulkSubcategory || null }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Bulk save failed') }
      toast.success(`Categorized ${selected.size} transactions`)
      setSelected(new Set())
      load(offset)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Bulk save failed')
    }
  }

  /**
   * Statement upload — ONE FILE PER REQUEST (see the route's own comment for
   * why), sent sequentially so a slow PDF doesn't block the others and each
   * file's real outcome (imported / quarantined / no transactions found /
   * error) is reported honestly rather than collapsed into one pass/fail.
   * Nothing gets categorized here — every row lands uncategorized, same rule
   * as everywhere else in this table.
   */
  async function uploadFiles(files: FileList) {
    const list = Array.from(files)
    setUploading({ done: 0, total: list.length })
    let totalImported = 0
    let totalAlreadyBooked = 0
    const problems: string[] = []
    // Parser warnings are NOT cosmetic and must never be swallowed. The reader
    // raises "Ambiguous date format — assumed M/D/Y (US)" when a statement gives it
    // no way to tell 05/03 apart; guess wrong on a European statement and every
    // date shifts, and near a year boundary rows land in the WRONG TAX YEAR, since
    // the year is derived from that same date. This warning existed, was returned
    // by the server, and was being dropped on the floor here.
    const warnings: string[] = []

    for (let i = 0; i < list.length; i++) {
      const file = list[i]
      try {
        const body = new FormData()
        body.append('file', file)
        // The year currently being viewed IS the year being loaded. Rows outside
        // it are skipped server-side and reported — a loan export carrying 2026
        // activity previously leaked 17 rows into an off-limits year.
        body.append('tax_year', String(year))
        const res = await fetch('/api/owner/transactions/upload', { method: 'POST', body })
        const d = await res.json().catch(() => ({}))
        if (!res.ok || d.error) {
          problems.push(`${file.name}: ${d.error || 'upload failed'}`)
        } else if (typeof d.imported === 'number') {
          totalImported += d.imported
          totalAlreadyBooked += d.skipped_already_booked ?? 0
          if (d.skipped_out_of_year > 0) {
            warnings.push(`${file.name}: ${d.skipped_out_of_year} transaction(s) dated outside ${year} were skipped — load those with that year selected.`)
          }
          if (d.imported === 0 && d.parsed_count > 0) {
            problems.push(`${file.name}: found ${d.parsed_count} transaction(s), all already in your books`)
          }
        }
        if (Array.isArray(d.warnings)) {
          for (const w of d.warnings) warnings.push(`${file.name}: ${w}`)
        }
        if (Array.isArray(d.duplicate_samples) && d.duplicate_samples.length > 0) {
          warnings.push(
            `${file.name}: ${d.skipped_already_booked} transaction(s) were already in your books from another source — e.g. ${d.duplicate_samples[0]}`
          )
        }
      } catch {
        problems.push(`${file.name}: upload failed`)
      }
      setUploading({ done: i + 1, total: list.length })
    }

    setUploading(null)
    if (totalImported > 0) {
      const dupNote = totalAlreadyBooked > 0 ? ` · ${totalAlreadyBooked} skipped as already booked` : ''
      toast.success(`Imported ${totalImported} new transaction(s) from ${list.length} file(s)${dupNote}`)
    }
    if (problems.length > 0) {
      toast.error(problems.length === 1 ? problems[0] : `${problems.length} file(s) need attention: ${problems.join(' | ')}`)
    } else if (totalImported === 0) {
      toast.error('Nothing new to import from those file(s)')
    }
    // Shown separately and persistently — a warning buried behind a green success
    // toast is a warning nobody reads, and these can mean money in the wrong year.
    for (const w of warnings.slice(0, 5)) {
      toast.warning(w, { duration: 15000 })
    }
    if (warnings.length > 5) {
      toast.warning(`…and ${warnings.length - 5} more parse warning(s).`, { duration: 15000 })
    }
    load(offset)
  }

  const uncategorizedCount = rows.filter(r => r.category === 'uncategorized').length

  return (
    <div className="space-y-4">
      {/* Categorize modal */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={e => { if (e.target === e.currentTarget) setModal(null) }}>
          <div className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl">
            <h3 className="mb-1 text-base font-semibold text-zinc-900">Categorize Transaction</h3>
            <p className="mb-4 text-sm text-zinc-500 truncate">{modal.tx.counterparty ?? modal.tx.description}</p>

            <div className="mb-3 flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2">
              <span className="text-sm text-zinc-500">{modal.tx.transaction_date} · {modal.tx.bank_name}</span>
              <span className={`text-sm font-semibold tabular-nums ${modal.tx.amount < 0 ? 'text-red-600' : 'text-green-600'}`}>
                {modal.tx.amount < 0 ? '-' : '+'}{fmtRow(modal.tx.amount, modal.tx.currency)}
              </span>
            </div>

            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600">Category</label>
                <select
                  value={modal.category}
                  onChange={e => setModal(m => m ? { ...m, category: e.target.value as OwnerCategory, subcategory: '', saveRule: false } : null)}
                  className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                >
                  {CATEGORIES.map(c => (
                    <option key={c} value={c}>{CATEGORY_LABELS[c] ?? c}</option>
                  ))}
                </select>
              </div>

              {/* "Transactions like this" — the QuickBooks pattern. The matched rows are
                  SHOWN, never just counted: the human must see what one click will label. */}
              {modal.tx.category === 'uncategorized' && modal.similar && modal.similar.count > 0 && (
                <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
                  <label className="flex items-center gap-2 text-sm text-blue-900">
                    <input
                      type="checkbox"
                      checked={modal.applyToAll}
                      onChange={e => setModal(m => m ? { ...m, applyToAll: e.target.checked } : null)}
                    />
                    <span><strong>{modal.similar.truncated ? 'At least ' : ''}{modal.similar.count} more</strong> transaction{modal.similar.count !== 1 ? 's look' : ' looks'} like this — apply to all {modal.similar.count + 1}</span>
                  </label>
                  <div className="max-h-24 space-y-0.5 overflow-y-auto rounded bg-white/60 px-2 py-1 text-xs text-blue-800">
                    {modal.similar.preview.map((p, i) => (
                      <div key={i} className="flex justify-between gap-2">
                        <span className="truncate">{p.text}</span>
                        <span className={`tabular-nums shrink-0 ${p.amount < 0 ? 'text-red-600' : 'text-green-700'}`}>
                          {p.amount < 0 ? '-' : '+'}{fmtRow(p.amount, modal.tx.currency)}
                        </span>
                      </div>
                    ))}
                    {modal.similar.count > modal.similar.preview.length && (
                      <div className="text-blue-500">…and {modal.similar.count - modal.similar.preview.length} more</div>
                    )}
                  </div>
                  {modal.similar.mixed_signs && modal.applyToAll && (
                    <div className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-800">
                      ⚠ This set mixes money IN and money OUT — one label is probably wrong for some of them. Check the list above.
                    </div>
                  )}
                  {(modal.similar.suggested_pattern || normalizeVendorKey(modal.tx.counterparty ?? modal.tx.description)) && (
                    <label className={`flex items-center gap-2 text-sm ${modal.subcategory ? 'text-blue-900' : 'text-blue-400'}`}>
                      <input
                        type="checkbox"
                        checked={modal.saveRule}
                        disabled={!modal.subcategory}
                        onChange={e => setModal(m => m ? { ...m, saveRule: e.target.checked } : null)}
                      />
                      <span>Always do this for &quot;{modal.similar.suggested_pattern || normalizeVendorKey(modal.tx.counterparty ?? modal.tx.description)}&quot;{!modal.subcategory ? ' (pick a subcategory first)' : ' — future ones arrive pre-suggested'}</span>
                    </label>
                  )}
                </div>
              )}

              {/* Double-count guard: invoice money is already counted from the payments
                  ledger — a bank deposit for a client invoice marked "income" here would
                  count the same money twice. */}
              {modal.category === 'income' && (
                (modal.tx.amount > 0 && modal.tx.transaction_ref?.startsWith('feed:')) ||
                (modal.applyToAll && modal.similar?.has_positive_feed_rows)
              ) && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                  ⚠ Is this a client paying an invoice? Then do NOT mark it Income — use the
                  &quot;This is for a client →&quot; button instead, or the money will be counted twice
                  (invoice income already includes it). &quot;Other Income&quot; is only for money that is
                  not an invoice payment (rewards, referral bonuses).
                  {modal.applyToAll ? ' This warning covers the whole "apply to all" set.' : ''}
                </div>
              )}

              {(SUBCATEGORIES[modal.category] ?? []).length > 0 && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-600">Subcategory</label>
                  <select
                    value={modal.subcategory}
                    onChange={e => setModal(m => m ? { ...m, subcategory: e.target.value, saveRule: e.target.value ? m.saveRule : false } : null)}
                    className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                  >
                    <option value="">— select subcategory —</option>
                    {SUBCATEGORIES[modal.category].map(s => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-600">Notes (optional)</label>
                <input
                  value={modal.notes}
                  onChange={e => setModal(m => m ? { ...m, notes: e.target.value } : null)}
                  onKeyDown={e => { if (e.key === 'Enter') saveModal() }}
                  placeholder="Add a note..."
                  className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-900"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setModal(null)} className="rounded-md border border-zinc-200 px-4 py-2 text-sm text-zinc-600 hover:bg-zinc-50">
                Cancel
              </button>
              <button
                onClick={saveModal}
                disabled={saving}
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Statement upload */}
      <div className="flex items-center gap-3">
        <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 ${uploading ? 'pointer-events-none opacity-60' : ''}`}>
          {uploading ? `Uploading ${uploading.done}/${uploading.total}…` : 'Upload statements'}
          <input
            type="file"
            multiple
            accept=".csv,.pdf"
            className="hidden"
            disabled={!!uploading}
            onChange={e => { if (e.target.files && e.target.files.length > 0) uploadFiles(e.target.files); e.target.value = '' }}
          />
        </label>
        <span className="text-xs text-zinc-500">CSV or PDF, any bank — lands uncategorized, nothing is guessed</span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search description or counterparty..."
          value={search}
          onChange={e => { setSearch(e.target.value); load(0, filterCategory, e.target.value) }}
          className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm w-64"
        />
        <select
          value={filterCategory}
          onChange={e => { setFilterCategory(e.target.value as OwnerCategory | ''); load(0, e.target.value as OwnerCategory | '', search) }}
          className="rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
        >
          <option value="">All categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c] ?? c}</option>)}
        </select>
        <span className="text-xs text-zinc-500">{total} transactions</span>
        {filterCategory === 'uncategorized' && uncategorizedCount > 0 && (
          <span className="rounded-full bg-orange-100 px-2.5 py-0.5 text-xs font-medium text-orange-700">
            {uncategorizedCount} need review
          </span>
        )}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5">
          <span className="text-sm font-medium text-blue-800">{selected.size} selected</span>
          <select
            value={bulkCategory}
            onChange={e => { setBulkCategory(e.target.value as OwnerCategory); setBulkSubcategory('') }}
            className="rounded border border-blue-200 bg-white px-2 py-1.5 text-sm"
          >
            {CATEGORIES.filter(c => c !== 'uncategorized').map(c => <option key={c} value={c}>{CATEGORY_LABELS[c] ?? c}</option>)}
          </select>
          {(SUBCATEGORIES[bulkCategory] ?? []).length > 0 && (
            <select
              value={bulkSubcategory}
              onChange={e => setBulkSubcategory(e.target.value)}
              className="rounded border border-blue-200 bg-white px-2 py-1.5 text-sm"
            >
              <option value="">— subcategory —</option>
              {SUBCATEGORIES[bulkCategory].map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          )}
          <button onClick={bulkCategorize} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700">
            Apply to {selected.size}
          </button>
          <button onClick={() => setSelected(new Set())} className="text-xs text-blue-600 hover:underline">Clear</button>
          {bulkCategory === 'income' && rows.some(r => selected.has(r.id) && r.amount > 0 && r.transaction_ref?.startsWith('feed:')) && (
            <span className="text-xs text-red-700">
              ⚠ Client invoice payments must NOT be marked Income (already counted from invoices) — use &quot;This is for a client →&quot; for those.
            </span>
          )}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 bg-zinc-50">
              <th className="w-8 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={selected.size === rows.length && rows.length > 0}
                  onChange={e => setSelected(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())}
                />
              </th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-zinc-500">Date</th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-zinc-500">Bank</th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-zinc-500">Counterparty / Description</th>
              <th className="px-3 py-2.5 text-right text-xs font-medium text-zinc-500">Amount</th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-zinc-500">Category</th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-zinc-500">Subcategory</th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-zinc-500">Notes</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map(tx => (
              <tr key={tx.id} className="border-b border-zinc-50 hover:bg-zinc-50">
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={selected.has(tx.id)}
                    onChange={e => {
                      const s = new Set(selected)
                      e.target.checked ? s.add(tx.id) : s.delete(tx.id)
                      setSelected(s)
                    }}
                  />
                </td>
                <td className="px-3 py-2.5 text-xs text-zinc-500 whitespace-nowrap">{tx.transaction_date}</td>
                <td className="px-3 py-2.5 text-xs text-zinc-400">{tx.bank_name}</td>
                <td className="px-3 py-2.5 max-w-[200px]">
                  <div className="truncate font-medium text-zinc-800">{tx.counterparty ?? '—'}</div>
                  <div className="truncate text-xs text-zinc-400">{tx.description}</div>
                </td>
                <td className={`px-3 py-2.5 text-right font-mono text-xs font-medium tabular-nums ${tx.amount < 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {tx.amount < 0 ? '-' : '+'}{fmtRow(tx.amount, tx.currency)}
                </td>
                <td className="px-3 py-2.5">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tx.category === 'uncategorized' ? 'bg-orange-100 text-orange-700' : 'bg-zinc-100 text-zinc-600'}`}>
                    {CATEGORY_LABELS[tx.category] ?? tx.category}
                  </span>
                  {(() => {
                    const s = suggestionFor(tx)
                    return s ? (
                      <FastTooltip label="Suggested by your saved rule — click to apply">
                        <button
                          onClick={() => acceptSuggestion(tx)}
                          aria-label="Suggested by your saved rule — click to apply"
                          className="ml-1.5 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-100"
                        >
                          → {CATEGORY_LABELS[s.category] ?? s.category}{s.subcategory ? ` · ${s.subcategory.replace(/_/g, ' ')}` : ''} ✓
                        </button>
                      </FastTooltip>
                    ) : null
                  })()}
                </td>
                <td className="px-3 py-2.5 text-xs text-zinc-500">{tx.subcategory?.replace(/_/g, ' ') ?? '—'}</td>
                <td className="px-3 py-2.5 text-xs text-zinc-400 max-w-[120px] truncate">{tx.notes ?? ''}</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => openModal(tx)}
                      className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                        tx.category === 'uncategorized'
                          ? 'bg-orange-50 text-orange-700 hover:bg-orange-100 border border-orange-200'
                          : 'border border-zinc-200 text-zinc-600 hover:bg-zinc-100'
                      }`}
                    >
                      {tx.category === 'uncategorized' ? 'Categorize ↗' : 'Edit'}
                    </button>
                    {/* Only a row that CAME from the bank feed can go back to it. This is the
                        escape hatch: anything the system could not identify as a client
                        payment lands here, and one click returns it to the Bank Feed. */}
                    {tx.transaction_ref?.startsWith('feed:') && (
                      <FastTooltip label="Move this back to Finance — it is a client paying an invoice">
                        <button
                          onClick={() => sendToFinance(tx)}
                          disabled={sendingRef === tx.transaction_ref}
                          aria-label="Move this back to Finance — it is a client paying an invoice"
                          className="rounded border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100 disabled:opacity-50"
                        >
                          {sendingRef === tx.transaction_ref ? 'Moving…' : 'This is for a client →'}
                        </button>
                      </FastTooltip>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {loading && (
              <tr><td colSpan={9} className="px-3 py-4 text-center text-sm text-zinc-400">Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-4 text-center text-sm text-zinc-400">No transactions found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > LIMIT && (
        <div className="flex items-center justify-between text-sm text-zinc-500">
          <span>Showing {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}</span>
          <div className="flex gap-2">
            <button disabled={offset === 0} onClick={() => load(offset - LIMIT)} className="rounded border px-3 py-1 disabled:opacity-40">← Prev</button>
            <button disabled={offset + LIMIT >= total} onClick={() => load(offset + LIMIT)} className="rounded border px-3 py-1 disabled:opacity-40">Next →</button>
          </div>
        </div>
      )}
    </div>
  )
}
