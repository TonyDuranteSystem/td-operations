'use client'

/**
 * "Reconcile backlog" — runs the referral backlog reconciler
 * (POST /api/referral/reconcile-backlog). Opens with a DRY-RUN report of every
 * converted-but-uncredited referral and what the system would do (credit /
 * cancel duplicate / needs staff decision); Apply executes only the safe
 * actions. Ambiguous rows are never auto-decided.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ListChecks, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ReportRow {
  referralId: string
  referrerName: string | null
  referredName: string | null
  amount: number | null
  currency: string | null
  createdAt: string | null
  decision: 'credit' | 'cancel_duplicate' | 'needs_decision'
  detail: string
  applied: boolean
  error?: string
}
interface Report {
  apply: boolean
  rows: ReportRow[]
  summary: { credit: number; cancel: number; needsDecision: number; errors: number }
}

const DECISION_STYLE: Record<ReportRow['decision'], { label: string; cls: string }> = {
  credit: { label: 'Credit', cls: 'bg-emerald-100 text-emerald-800' },
  cancel_duplicate: { label: 'Cancel duplicate', cls: 'bg-red-100 text-red-700' },
  needs_decision: { label: 'Needs decision', cls: 'bg-amber-100 text-amber-800' },
}

export function ReconcileBacklogButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<Report | null>(null)

  async function run(apply: boolean) {
    setLoading(true)
    try {
      const res = await fetch('/api/referral/reconcile-backlog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apply }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Reconcile failed.')
      setReport(data as Report)
      if (apply) {
        const r = data as Report
        toast.success(`Backlog reconciled — ${r.summary.credit} credited, ${r.summary.cancel} duplicate${r.summary.cancel !== 1 ? 's' : ''} cancelled.`)
        router.refresh()
      }
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Reconcile failed.')
    } finally {
      setLoading(false)
    }
  }

  function openAndCheck() {
    setOpen(true)
    setReport(null)
    void run(false)
  }

  const actionable = (report?.summary.credit ?? 0) + (report?.summary.cancel ?? 0)

  return (
    <>
      <button
        onClick={openAndCheck}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md border text-zinc-700 hover:bg-zinc-50 transition-colors"
        title="Check uncredited past referrals and issue the clear ones"
      >
        <ListChecks className="h-4 w-4" /> Reconcile backlog
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !loading && setOpen(false)}>
          <div className="w-full max-w-3xl rounded-xl bg-white shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h3 className="text-base font-semibold">Referral backlog{report && !report.apply ? ' — dry run' : ''}</h3>
              <button onClick={() => !loading && setOpen(false)} className="text-zinc-400 hover:text-zinc-600"><X className="h-5 w-5" /></button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
              {loading && !report && (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Checking uncredited referrals…
                </div>
              )}
              {report && report.rows.length === 0 && (
                <p className="py-10 text-center text-sm text-zinc-500">No uncredited referrals — the backlog is clean. ✅</p>
              )}
              {report && report.rows.length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-zinc-50/50 text-left text-zinc-500">
                      <th className="px-3 py-2 font-medium">Referrer</th>
                      <th className="px-3 py-2 font-medium">Referred</th>
                      <th className="px-3 py-2 font-medium text-right">Amount</th>
                      <th className="px-3 py-2 font-medium">Action</th>
                      <th className="px-3 py-2 font-medium">Detail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {report.rows.map(r => {
                      const d = DECISION_STYLE[r.decision]
                      return (
                        <tr key={r.referralId} className={cn(r.error && 'bg-red-50')}>
                          <td className="px-3 py-2 font-medium">{r.referrerName ?? '—'}</td>
                          <td className="px-3 py-2">{r.referredName ?? '—'}</td>
                          <td className="px-3 py-2 text-right">
                            {r.amount ? `${r.currency === 'EUR' ? '€' : '$'}${Number(r.amount).toLocaleString()}` : '—'}
                          </td>
                          <td className="px-3 py-2">
                            <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap', d.cls)}>
                              {d.label}{report.apply && r.applied ? ' ✓' : ''}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-xs text-zinc-500">{r.error ?? r.detail}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 border-t px-5 py-3">
              <p className="text-xs text-zinc-500">
                {report ? `${report.summary.credit} to credit · ${report.summary.cancel} duplicate · ${report.summary.needsDecision} need a decision` : ''}
              </p>
              <div className="flex gap-2">
                <button onClick={() => !loading && setOpen(false)} className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">Close</button>
                {report && !report.apply && actionable > 0 && (
                  <button
                    onClick={() => run(true)}
                    disabled={loading}
                    className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                    Apply {actionable} action{actionable !== 1 ? 's' : ''}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
