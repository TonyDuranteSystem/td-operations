'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, DollarSign, Check, X, FileText, HandCoins } from 'lucide-react'
import { formatUsd, PAYOUT_METHODS, type RevenueDashboard, type RevenueProjectRow, type TdCommPayoutRow } from '@/lib/td-communication/revenue'

const STATUS_LABELS: Record<string, string> = {
  enrolled: 'Package Selected', form_submitted: 'Form Submitted', in_progress: 'In Progress',
  concept_ready: 'Ready for Review', approved: 'Approved', revision: 'Revision',
  delivered: 'Delivered', cancelled: 'Cancelled',
}

/**
 * CRM Revenue tab (admin writes, staff read-only). Shows the two-stage money
 * picture: client receivables (main ledger), Cris's earnings (recognized →
 * ready-to-withdraw), and the payout request queue. Admin-only writes gate on the
 * server; this UI simply disables its controls for non-admins.
 */
export function RevenueAdmin({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<RevenueDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/td-communication/admin/revenue')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load revenue.')
      }
      const json = await res.json()
      setData(json.dashboard ?? null)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to load revenue.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const post = useCallback(async (url: string, body?: unknown, ok = 'Done') => {
    setBusy(url)
    try {
      const res = await fetch(url, {
        method: url.includes('/revenue') && body && 'amount' in (body as object) ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Action failed.')
      toast.success(ok)
      await load()
      return true
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Action failed.')
      return false
    } finally {
      setBusy(null)
    }
  }, [load])

  const payoutAction = useCallback(async (action: string, payout_id: string, payout_method?: string) => {
    setBusy(payout_id + action)
    try {
      const res = await fetch('/api/crm/admin-actions/partner-actions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, params: { payout_id, ...(payout_method ? { payout_method } : {}) } }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || d.success === false) throw new Error(d.detail || d.error || 'Action failed.')
      toast.success(d.detail || 'Done')
      await load()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Action failed.')
    } finally {
      setBusy(null)
    }
  }, [load])

  if (loading) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
  }
  if (!data) {
    return <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">No revenue data.</div>
  }

  const t = data.totals

  return (
    <div className="flex-1 min-h-0 overflow-y-auto pr-0.5 space-y-5">
      {/* Summary cards */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-2">Client revenue (main ledger)</p>
        <div className="flex flex-wrap gap-2">
          <Card label="Collected" value={formatUsd(t.clientCollected)} tone="green" />
          <Card label="Outstanding" value={formatUsd(t.clientOutstanding)} tone="amber" />
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400 mb-2">Cris — earnings & payouts</p>
        <div className="flex flex-wrap gap-2">
          <Card label="Earned, waiting on client" value={formatUsd(t.partnerEarnedWaiting)} tone="zinc" />
          <Card label="Ready to withdraw" value={formatUsd(Math.max(0, t.partnerReadyToWithdraw))} tone="blue" />
          <Card label="In request/approval" value={formatUsd(t.partnerInRequest)} tone="amber" />
          <Card label="Paid out" value={formatUsd(t.partnerPaidOut)} tone="green" />
          {t.partnerReadyToWithdraw < 0 && (
            <Card label="⚠ Over-drawn (refund?)" value={formatUsd(t.partnerReadyToWithdraw)} tone="red" />
          )}
        </div>
      </div>

      {/* Payout requests */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <HandCoins className="h-4 w-4 text-zinc-500" />
          <p className="text-sm font-semibold text-zinc-800">Payout requests</p>
          {t.pendingRequests > 0 && <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{t.pendingRequests} pending</span>}
        </div>
        {data.payouts.length === 0 ? (
          <p className="text-sm text-zinc-400">No payout requests yet.</p>
        ) : (
          <div className="border rounded-lg bg-white divide-y divide-zinc-100">
            {data.payouts.map((p) => (
              <PayoutRow key={p.id} p={p} isAdmin={isAdmin} busy={busy} onAction={payoutAction} partnerName={p.partner_id ? data.partnerNames[p.partner_id] : null} />
            ))}
          </div>
        )}
      </div>

      {/* Per-project table */}
      <div>
        <p className="text-sm font-semibold text-zinc-800 mb-2">Projects</p>
        <div className="border rounded-lg bg-white overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Client</th>
                <th className="text-left px-3 py-2 font-medium">Package</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">Client payment</th>
                <th className="text-left px-3 py-2 font-medium">Cris earns</th>
                <th className="text-left px-3 py-2 font-medium">Earning</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.projects.map((row) => (
                <ProjectRow key={row.id} row={row} isAdmin={isAdmin} busy={busy} onPost={post} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function ProjectRow({ row, isAdmin, busy, onPost }: {
  row: RevenueProjectRow
  isAdmin: boolean
  busy: string | null
  onPost: (url: string, body?: unknown, ok?: string) => Promise<boolean>
}) {
  const [amount, setAmount] = useState<string>(row.partner_amount_usd === null ? '' : String(row.partner_amount_usd))
  const base = `/api/td-communication/admin/enrollments/${row.id}`

  const saveAmount = async () => {
    const n = Number(amount)
    if (!Number.isFinite(n) || n < 0) { toast.error('Enter a non-negative amount.'); return }
    if (n === (row.partner_amount_usd ?? 0)) return
    await onPost(`${base}/revenue`, { amount: n }, 'Amount saved')
  }

  const earnedBadge = row.status === 'cancelled'
    ? <Badge tone="zinc">—</Badge>
    : row.available
      ? <Badge tone="blue">Ready</Badge>
      : row.recognized
        ? <Badge tone="amber">Earned</Badge>
        : <Badge tone="zinc">Not yet</Badge>

  return (
    <tr className="hover:bg-zinc-50">
      <td className="px-3 py-2"><span className="font-medium text-zinc-900">{row.subjectName}</span></td>
      <td className="px-3 py-2 text-zinc-700">{row.packageLabel}</td>
      <td className="px-3 py-2 text-zinc-600">{STATUS_LABELS[row.status] ?? row.status}</td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span className={
            row.clientPaidState === 'paid' || row.client_paid_override_at ? 'text-emerald-700 font-medium'
            : row.clientPaidState === 'unbilled' ? 'text-zinc-400' : 'text-amber-700'
          }>
            {row.client_paid_override_at ? 'Paid (off-platform)' : row.clientPaidState === 'paid' ? 'Paid' : row.clientPaidState === 'unbilled' ? 'Not billed' : 'Unpaid'}
          </span>
          {isAdmin && row.clientPaidState === 'unbilled' && (
            <button className="text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-zinc-200 text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
              disabled={busy === `${base}/bill`}
              title="Sends a portal invoice the client must pay"
              onClick={() => onPost(`${base}/bill`, undefined, 'Client invoice created')}>
              <FileText className="h-3 w-3" /> Bill client
            </button>
          )}
          {isAdmin && row.clientPaidState !== 'paid' && !row.client_paid_override_at && (
            <button className="text-[11px] px-1.5 py-0.5 rounded border border-zinc-200 text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
              disabled={busy === `${base}/client-paid`}
              title="Mark the client as paid off-platform"
              onClick={() => onPost(`${base}/client-paid`, {}, 'Marked client paid')}>
              Mark paid
            </button>
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        {isAdmin ? (
          <div className="inline-flex items-center gap-1">
            <span className="text-zinc-400">$</span>
            <input
              type="number" min="0" step="0.01" value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onBlur={saveAmount}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              className="w-20 border rounded px-1.5 py-0.5 text-sm"
              placeholder="0.00"
            />
          </div>
        ) : (
          <span className="text-zinc-700">{row.partner_amount_usd === null ? '—' : formatUsd(row.partner_amount_usd)}</span>
        )}
      </td>
      <td className="px-3 py-2">{earnedBadge}</td>
    </tr>
  )
}

function PayoutRow({ p, isAdmin, busy, onAction, partnerName }: {
  p: TdCommPayoutRow
  isAdmin: boolean
  busy: string | null
  onAction: (action: string, id: string, method?: string) => Promise<void>
  partnerName: string | null
}) {
  const [method, setMethod] = useState<string>(PAYOUT_METHODS[0])
  const open = p.status === 'requested' || p.status === 'pending' || p.status === 'manual_review'
  const approved = p.status === 'approved'
  const statusTone = p.status === 'paid' ? 'text-emerald-700' : p.status === 'rejected' ? 'text-zinc-400 line-through' : approved ? 'text-blue-700' : 'text-amber-700'

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-zinc-900">{formatUsd(p.amount)}</span>
          <span className={`text-xs font-medium ${statusTone}`}>{p.status}</span>
          {partnerName && <span className="text-xs text-zinc-400">· {partnerName}</span>}
        </div>
        {p.note && <p className="text-xs text-zinc-500 truncate">{p.note}</p>}
      </div>
      {isAdmin && (open || approved) && (
        <div className="shrink-0 flex items-center gap-1.5">
          {open && (
            <>
              <button className="text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                disabled={busy === p.id + 'approve_payout'} onClick={() => onAction('approve_payout', p.id)}>
                <Check className="h-3 w-3" /> Approve
              </button>
              <button className="text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-zinc-200 text-zinc-500 hover:bg-zinc-100 disabled:opacity-50"
                disabled={busy === p.id + 'reject_payout'} onClick={() => onAction('reject_payout', p.id)}>
                <X className="h-3 w-3" /> Reject
              </button>
            </>
          )}
          {approved && (
            <>
              <select className="text-[11px] border rounded px-1 py-0.5" value={method} onChange={(e) => setMethod(e.target.value)}>
                {PAYOUT_METHODS.map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
              </select>
              <button className="text-[11px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                disabled={busy === p.id + 'mark_payout_paid'} onClick={() => onAction('mark_payout_paid', p.id, method)}>
                <DollarSign className="h-3 w-3" /> Mark paid
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

type Tone = 'zinc' | 'blue' | 'green' | 'amber' | 'red'
const TONE: Record<Tone, string> = {
  zinc: 'bg-white text-zinc-700 border-zinc-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  red: 'bg-red-50 text-red-700 border-red-200',
}
function Card({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${TONE[tone]}`}>
      <div className="text-lg font-bold leading-tight">{value}</div>
      <div className="text-[11px] text-zinc-500">{label}</div>
    </div>
  )
}
function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded border ${TONE[tone]}`}>{children}</span>
}
