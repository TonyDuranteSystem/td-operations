'use client'

/**
 * Old, pre-invoice payment records — manual/older charges that predate this
 * system's formal invoicing, so they carry no invoice_status at all (dev job
 * ef5da377). Deliberately READ-ONLY here and deliberately its own component,
 * not folded into AllInvoicesTab's row rendering: that table's actions
 * (Send/Void/Mark-Paid/Reactivate) assume a real invoice document exists and
 * have no guard for a row that has never had one — a live review found that
 * surfacing these rows through the ordinary path would let one of them be
 * emailed to a client as a fresh, unpaid invoice even when it was already
 * settled. Editing and marking these paid stays on the Account page's
 * existing "Legacy (pre-invoice)" section, which already has correct,
 * tested guards for this exact row shape — this panel only makes them
 * findable and shows their real amount and status, with a link straight to
 * where they're actually handled.
 */

import Link from 'next/link'
import { User, Building2 } from 'lucide-react'

export interface LegacyPaymentRecord {
  id: string
  description: string | null
  amount: number
  currency: string
  /** The payment_status enum value, as-is — never mapped onto the invoice
   *  status vocabulary (Draft/Sent/...), which these rows were never part
   *  of and must never be mistaken for. */
  status: string
  due_date: string | null
  paid_date: string | null
  account_id: string | null
  contact_id: string | null
  accounts: { company_name: string } | null
  contacts: { full_name: string } | null
}

const LEGACY_STATUS_COLORS: Record<string, string> = {
  Paid: 'bg-emerald-100 text-emerald-700',
  Pending: 'bg-amber-100 text-amber-700',
  Overdue: 'bg-red-100 text-red-700',
  Delinquent: 'bg-red-100 text-red-700',
  Waived: 'bg-zinc-100 text-zinc-500',
  Refunded: 'bg-zinc-100 text-zinc-500',
  'Not Invoiced': 'bg-zinc-100 text-zinc-500',
  Cancelled: 'bg-zinc-200 text-zinc-500 line-through',
}

function formatCurrency(amount: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(amount)
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—'
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(dateStr))
  } catch {
    return '—'
  }
}

export function LegacyPaymentsPanel({ payments, totalCount }: { payments: LegacyPaymentRecord[]; totalCount: number }) {
  return (
    <div className="space-y-3">
      <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900">
        Older, manual charges recorded before this system had formal invoices — no invoice PDF, no send/void/mark-paid here.
        Open the client&apos;s account to edit or settle one.
      </div>

      {payments.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          {totalCount === 0 ? 'No legacy pre-invoice records.' : 'No legacy records match your search.'}
        </p>
      )}

      {/* The server query caps at 200 rows with no pagination — surfaced
          here so it reads as "there's more, narrow your search" rather than
          silently missing an older record (bug-hunter pass, dev job
          ef5da377). */}
      {totalCount >= 200 && (
        <p className="text-xs text-muted-foreground">Showing the most recent {totalCount} — search by client or description to narrow further.</p>
      )}

      <div className="space-y-2">
        {payments.map(p => (
          <Link
            key={p.id}
            href={p.account_id ? `/accounts/${p.account_id}` : p.contact_id ? `/contacts/${p.contact_id}` : '#'}
            className="flex items-center gap-3 p-3 rounded-lg border bg-white hover:border-zinc-300 transition-colors"
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium truncate">{p.description ?? 'Legacy payment'}</p>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                {p.account_id ? <Building2 className="h-3 w-3" /> : <User className="h-3 w-3" />}
                <span className="truncate">{p.accounts?.company_name ?? p.contacts?.full_name ?? '—'}</span>
                {p.due_date && <span>· Due {formatDate(p.due_date)}</span>}
                {p.paid_date && <span>· Paid {formatDate(p.paid_date)}</span>}
              </div>
            </div>
            <span className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${LEGACY_STATUS_COLORS[p.status] ?? 'bg-zinc-100 text-zinc-600'}`}>
              {p.status}
            </span>
            <span className="shrink-0 font-medium text-right w-24">{formatCurrency(p.amount, p.currency)}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
