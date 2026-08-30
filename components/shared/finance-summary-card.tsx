'use client'

import { useState } from 'react'
import { CreditCard, Receipt, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { FinanceSummary } from '@/lib/billing/finance-summary'
import type { ActionResult } from '@/lib/server-action'

// Matches the money-display safety rule from account-detail.tsx's own
// formatCurrency (council pass, 2026-08-14): a fallback that visibly shows an
// unexpected currency code rather than silently mislabeling it as $.
function formatCurrency(amount: number, currency?: string | null): string {
  const c = currency === 'EUR' ? '€' : currency === 'USD' || !currency ? '$' : `${currency} `
  return `${c}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

interface FinanceSummaryCardProps {
  accountId?: string
  companyName?: string | null
  summary: FinanceSummary
  /** Autopay is account-scoped only — no contact-level concept exists.
   *  Set false for a contact-only ("Personal, no company") invoice summary
   *  to hide the whole autopay row instead of showing a misleading "Off". */
  showAutopay?: boolean
  autopayEnabled?: boolean
  autopayLast4?: string | null
  /** Staff actions (turn off / send enrollment link) only render when true —
   *  matches this codebase's convention of gating money-affecting actions to
   *  admins (see the account Payments tab's own adminOnly flag). */
  isAdmin?: boolean
  onDisable?: (accountId: string) => Promise<ActionResult>
  onSendLink?: (accountId: string) => Promise<ActionResult>
}

export function FinanceSummaryCard({
  accountId,
  companyName,
  summary,
  showAutopay = true,
  autopayEnabled,
  autopayLast4,
  isAdmin,
  onDisable,
  onSendLink,
}: FinanceSummaryCardProps) {
  const [loading, setLoading] = useState(false)

  const handleDisable = async () => {
    if (loading || !accountId || !onDisable) return
    if (!window.confirm(`Turn off autopay for ${companyName || 'this account'}? Future invoices will need to be paid manually and the 5% card fee will apply again.`)) return
    setLoading(true)
    const result = await onDisable(accountId)
    setLoading(false)
    if (result.success) toast.success('Autopay turned off')
    else toast.error(result.error || 'Failed to turn off autopay')
  }

  const handleSendLink = async () => {
    if (loading || !accountId || !onSendLink) return
    setLoading(true)
    const result = await onSendLink(accountId)
    setLoading(false)
    if (result.success) toast.success('Enrollment link sent to the client')
    else toast.error(result.error || 'Failed to send the enrollment link')
  }

  return (
    <div className="bg-white rounded-lg border p-5 space-y-4">
      <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground flex items-center gap-2">
        <Receipt className="h-4 w-4" />
        Finance{companyName ? ` — ${companyName}` : ''}
      </h3>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Outstanding</p>
          <p className="font-medium">
            {formatCurrency(summary.outstandingTotal, summary.currency)}
            <span className="text-muted-foreground font-normal"> · {summary.outstandingCount} invoice{summary.outstandingCount === 1 ? '' : 's'}</span>
          </p>
          {summary.overdueCount > 0 && (
            <p className="text-xs text-red-600 mt-0.5">{summary.overdueCount} overdue</p>
          )}
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Paid</p>
          <p className="font-medium">
            {formatCurrency(summary.paidTotal, summary.currency)}
            <span className="text-muted-foreground font-normal"> · {summary.paidCount} invoice{summary.paidCount === 1 ? '' : 's'}</span>
          </p>
        </div>
      </div>

      {showAutopay && (
        <div className="flex items-center justify-between pt-3 border-t gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <CreditCard className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm truncate">
              Autopay:{' '}
              {autopayEnabled ? (
                <span className="text-emerald-600 font-medium">
                  On{autopayLast4 ? ` (card ending ${autopayLast4})` : ''}
                </span>
              ) : (
                <span className="text-zinc-500">Off</span>
              )}
            </span>
          </div>
          {isAdmin && (
            autopayEnabled ? (
              <button
                type="button"
                onClick={handleDisable}
                disabled={loading}
                className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50 disabled:opacity-60"
              >
                {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                Turn off
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSendLink}
                disabled={loading}
                className="shrink-0 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                Send enrollment link
              </button>
            )
          )}
        </div>
      )}
    </div>
  )
}
