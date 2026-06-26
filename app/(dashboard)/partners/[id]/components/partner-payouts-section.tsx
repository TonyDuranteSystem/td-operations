'use client'

import { Fragment, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, CheckCircle2, Send } from 'lucide-react'

export type PayoutStatus = 'pending' | 'manual_review' | 'requested' | 'approved' | 'paid' | 'cancelled'

export interface PayoutBankDetails {
  account_name?: string
  account_number?: string
  iban?: string
  swift_bic?: string
  bank_name?: string
  note?: string
}

export interface PayoutRow {
  id: string
  status: PayoutStatus
  amount: number
  currency: string
  payout_type: string | null
  payout_method: string | null
  payment_id: string | null
  approved_at: string | null
  paid_at: string | null
  created_at: string | null
  notes: string | null
  payout_request: PayoutBankDetails | null
  invoice_url: string | null
  invoice_name: string | null
  invoice_signed_url?: string | null
  requested_at: string | null
}

interface Props {
  partnerId: string
  payouts: PayoutRow[]
}

const PAYOUT_METHODS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'credit_note', label: 'Credit note' },
  { value: 'invoice_deduction', label: 'Invoice deduction' },
]

const STATUS_BADGE: Record<PayoutStatus, string> = {
  pending: 'bg-amber-100 text-amber-800',
  manual_review: 'bg-orange-100 text-orange-800',
  requested: 'bg-violet-100 text-violet-800',
  approved: 'bg-blue-100 text-blue-800',
  paid: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-zinc-100 text-zinc-600',
}

export function PartnerPayoutsSection({ partnerId, payouts }: Props) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [methodById, setMethodById] = useState<Record<string, string>>({})

  const totalPending = payouts
    .filter(p => p.status === 'pending' || p.status === 'manual_review')
    .reduce((sum, p) => sum + p.amount, 0)
  const totalApproved = payouts
    .filter(p => p.status === 'approved')
    .reduce((sum, p) => sum + p.amount, 0)
  const totalPaid = payouts
    .filter(p => p.status === 'paid')
    .reduce((sum, p) => sum + p.amount, 0)

  async function callAction(action: string, body: Record<string, unknown>) {
    setError(null)
    const res = await fetch('/api/crm/admin-actions/partner-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params: body }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.success === false) {
      throw new Error(data.detail || `HTTP ${res.status}`)
    }
    return data
  }

  async function handleApprove(id: string) {
    if (busyId) return
    setBusyId(id)
    try {
      await callAction('approve_payout', { payout_id: id })
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed')
    } finally {
      setBusyId(null)
    }
  }

  async function handleMarkPaid(id: string) {
    if (busyId) return
    const method = methodById[id]
    if (!method) {
      setError('Select a payout method first')
      return
    }
    setBusyId(id)
    try {
      await callAction('mark_payout_paid', { payout_id: id, payout_method: method })
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Mark-paid failed')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="bg-white rounded-lg border p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
          Partner Payouts
        </h3>
        <span className="text-xs text-muted-foreground">
          partner_id: <code className="bg-zinc-50 px-1 rounded">{partnerId.slice(0, 8)}…</code>
        </span>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-amber-50 rounded-lg p-3 text-center">
          <div className="text-xl font-bold text-amber-700">${totalPending.toLocaleString()}</div>
          <div className="text-[10px] text-amber-600 uppercase tracking-wide">Pending review</div>
        </div>
        <div className="bg-blue-50 rounded-lg p-3 text-center">
          <div className="text-xl font-bold text-blue-700">${totalApproved.toLocaleString()}</div>
          <div className="text-[10px] text-blue-600 uppercase tracking-wide">Approved</div>
        </div>
        <div className="bg-emerald-50 rounded-lg p-3 text-center">
          <div className="text-xl font-bold text-emerald-700">${totalPaid.toLocaleString()}</div>
          <div className="text-[10px] text-emerald-600 uppercase tracking-wide">Paid</div>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          {error}
        </div>
      )}

      {payouts.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground py-6">
          No payouts yet. Payouts are created automatically when a partner-driven offer is paid.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b">
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Amount</th>
                <th className="py-2 pr-3">Model</th>
                <th className="py-2 pr-3">Created</th>
                <th className="py-2 pr-3">Notes</th>
                <th className="py-2 pr-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {payouts.map(p => {
                const isApprovable = p.status === 'pending' || p.status === 'manual_review' || p.status === 'requested'
                const isApproved = p.status === 'approved'
                const req = p.payout_request
                return (
                  <Fragment key={p.id}>
                  <tr className="border-b last:border-0 align-middle">
                    <td className="py-2 pr-3">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${STATUS_BADGE[p.status]}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="py-2 pr-3 font-medium">
                      {p.currency === 'USD' ? '$' : '€'}{p.amount.toLocaleString()}
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      {p.payout_type ?? '—'}
                      {p.payout_method ? ` → ${p.payout_method}` : ''}
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      {p.created_at ? new Date(p.created_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground max-w-xs truncate" title={p.notes ?? ''}>
                      {p.notes ?? '—'}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {isApprovable && (
                        <button
                          onClick={() => handleApprove(p.id)}
                          disabled={busyId === p.id}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                        >
                          {busyId === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                          Approve
                        </button>
                      )}
                      {isApproved && (
                        <div className="inline-flex items-center gap-2">
                          <select
                            value={methodById[p.id] ?? ''}
                            onChange={e => setMethodById(prev => ({ ...prev, [p.id]: e.target.value }))}
                            className="text-xs px-2 py-1 border rounded"
                          >
                            <option value="">Method…</option>
                            {PAYOUT_METHODS.map(m => (
                              <option key={m.value} value={m.value}>{m.label}</option>
                            ))}
                          </select>
                          <button
                            onClick={() => handleMarkPaid(p.id)}
                            disabled={busyId === p.id || !methodById[p.id]}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
                          >
                            {busyId === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                            Mark Paid
                          </button>
                        </div>
                      )}
                      {p.status === 'paid' && (
                        <span className="text-xs text-muted-foreground">
                          Paid {p.paid_at ? new Date(p.paid_at).toLocaleDateString() : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                  {req && (p.status === 'requested' || p.status === 'approved' || p.status === 'paid') && (
                    <tr className="bg-violet-50/40 border-b">
                      <td colSpan={6} className="px-3 pb-2 text-xs text-zinc-600">
                        <span className="font-medium text-zinc-700">Partner bank details (USD)</span>
                        {p.requested_at ? ` · requested ${new Date(p.requested_at).toLocaleDateString()}` : ''}:{' '}
                        {[
                          req.account_name && `Name: ${req.account_name}`,
                          req.bank_name && `Bank: ${req.bank_name}`,
                          req.account_number && `Acct: ${req.account_number}`,
                          req.iban && `IBAN: ${req.iban}`,
                          req.swift_bic && `SWIFT: ${req.swift_bic}`,
                          req.note && `Note: ${req.note}`,
                        ].filter(Boolean).join(' · ') || '—'}
                        {p.invoice_signed_url && (
                          <> · <a href={p.invoice_signed_url} target="_blank" rel="noopener noreferrer" className="text-violet-700 underline">Invoice{p.invoice_name ? ` (${p.invoice_name})` : ''}</a></>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
