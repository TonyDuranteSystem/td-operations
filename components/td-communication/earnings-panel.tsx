'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, HandCoins, Wallet } from 'lucide-react'
import { formatUsd, type PartnerEarnings } from '@/lib/td-communication/revenue'

const STATUS_LABELS: Record<string, string> = {
  enrolled: 'Package Selected', form_submitted: 'Form Submitted', in_progress: 'In Progress',
  concept_ready: 'Ready for Review', approved: 'Approved', revision: 'Revision',
  delivered: 'Delivered', cancelled: 'Cancelled',
}

/**
 * Partner Earnings view (/collab). Shows Cris's own money as a bank balance —
 * earned-waiting → ready-to-withdraw → paid-out — and lets him request a payout.
 * NEVER shows client price / what the client paid (only whether an earning is
 * withdrawable). All amounts here are HIS earnings, served by the scoped
 * /earnings endpoint.
 */
export function EarningsPanel() {
  const [data, setData] = useState<PartnerEarnings | null>(null)
  const [loading, setLoading] = useState(true)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/td-communication/earnings')
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load earnings.')
      }
      const json = await res.json()
      setData(json.earnings ?? null)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to load earnings.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const ready = data ? Math.max(0, data.balance.readyToWithdraw) : 0

  const requestPayout = async () => {
    const n = Number(amount)
    if (!Number.isFinite(n) || n <= 0) { toast.error('Enter a positive amount.'); return }
    if (n > ready) { toast.error(`You can withdraw up to ${formatUsd(ready)}.`); return }
    setSubmitting(true)
    try {
      const res = await fetch('/api/td-communication/payouts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: n, note: note.trim() || undefined }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Failed to request payout.')
      toast.success('Payout requested')
      setAmount(''); setNote('')
      await load()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to request payout.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
  }
  if (!data) {
    return <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">No earnings yet.</div>
  }

  const b = data.balance

  return (
    <div className="flex-1 min-h-0 overflow-y-auto max-w-3xl w-full mx-auto space-y-5">
      {/* Balance cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Card label="Earned — waiting on client" value={formatUsd(b.earnedWaiting)} tone="zinc" />
        <Card label="Ready to withdraw" value={formatUsd(ready)} tone="blue" />
        <Card label="In request/approval" value={formatUsd(b.inRequest)} tone="amber" />
        <Card label="Paid out" value={formatUsd(b.paidOut)} tone="green" />
      </div>

      {/* Request payout */}
      <div className="bg-white rounded-lg border border-zinc-200 p-4">
        <div className="flex items-center gap-2 mb-3">
          <HandCoins className="h-4 w-4 text-blue-600" />
          <h2 className="text-sm font-semibold text-zinc-900">Request a payout</h2>
        </div>
        {ready <= 0 ? (
          <p className="text-sm text-zinc-500">Nothing available to withdraw yet. Earnings become available once the client has paid.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="block text-[11px] text-zinc-500 mb-0.5">Amount (max {formatUsd(ready)})</label>
              <div className="inline-flex items-center gap-1">
                <span className="text-zinc-400">$</span>
                <input type="number" min="0" step="0.01" max={ready} value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-28 border rounded px-2 py-1 text-sm" placeholder="0.00" />
              </div>
            </div>
            <div className="flex-1 min-w-[10rem]">
              <label className="block text-[11px] text-zinc-500 mb-0.5">Note (optional)</label>
              <input value={note} onChange={(e) => setNote(e.target.value)}
                className="w-full border rounded px-2 py-1 text-sm" placeholder="e.g. bank transfer to…" />
            </div>
            <button onClick={requestPayout} disabled={submitting}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
              Request
            </button>
          </div>
        )}
      </div>

      {/* Projects (his earnings, no client price) */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-900 mb-2">Your projects</h2>
        {data.projects.length === 0 ? (
          <p className="text-sm text-zinc-400">No projects assigned yet.</p>
        ) : (
          <div className="border rounded-lg bg-white divide-y divide-zinc-100">
            {data.projects.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-zinc-900">{p.packageLabel}</span>
                  <span className="ml-2 text-xs text-zinc-500">{STATUS_LABELS[p.status] ?? p.status}</span>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  <span className="text-sm font-semibold text-zinc-900">{formatUsd(p.amount)}</span>
                  {p.status === 'cancelled' ? <Badge tone="zinc">—</Badge>
                    : p.available ? <Badge tone="blue">Ready</Badge>
                    : p.recognized ? <Badge tone="amber">Earned</Badge>
                    : <Badge tone="zinc">Pending</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Payout history */}
      {data.payouts.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-zinc-900 mb-2">Payout history</h2>
          <div className="border rounded-lg bg-white divide-y divide-zinc-100">
            {data.payouts.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <span className="text-sm font-semibold text-zinc-900">{formatUsd(p.amount)}</span>
                  {p.note && <span className="ml-2 text-xs text-zinc-500 truncate">{p.note}</span>}
                </div>
                <span className={`text-xs font-medium ${p.status === 'paid' ? 'text-emerald-700' : p.status === 'rejected' ? 'text-zinc-400 line-through' : p.status === 'approved' ? 'text-blue-700' : 'text-amber-700'}`}>
                  {p.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

type Tone = 'zinc' | 'blue' | 'green' | 'amber'
const TONE: Record<Tone, string> = {
  zinc: 'bg-white text-zinc-700 border-zinc-200',
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
}
function Card({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${TONE[tone]}`}>
      <div className="text-base font-bold leading-tight">{value}</div>
      <div className="text-[11px] text-zinc-500 leading-tight mt-0.5">{label}</div>
    </div>
  )
}
function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded border ${TONE[tone]}`}>{children}</span>
}
