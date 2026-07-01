'use client'

import { useState } from 'react'
import { Building2 } from 'lucide-react'
import { AccountCombobox } from '@/components/shared/account-combobox'
import { TaxFinancialsReview } from '@/components/portal/tax-financials-review'

/**
 * Staff standalone entry to the existing tax-financials system. Pick any client
 * + year, then drive the SAME review the client sees in the portal — upload
 * PDF/CSV statements (background-ingested + saved to the client's records),
 * categorization (rules + advisory AI, staff confirm the tail), the six
 * verification gates, the P&L + Balance Sheet, and the Excel download —
 * rendered in `mode="staff"` (no client attestation / portal-wizard links).
 */
export function StaffFinancials({ defaultYear }: { defaultYear: number }) {
  const [accountId, setAccountId] = useState<string | undefined>()
  const [accountName, setAccountName] = useState<string | undefined>()
  const [year, setYear] = useState(String(defaultYear))
  const [open, setOpen] = useState<{ accountId: string; accountName: string; taxYear: number } | null>(null)

  if (open) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-white px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <Building2 className="h-4 w-4 text-zinc-500 shrink-0" />
            <span className="text-sm font-medium text-zinc-800 truncate">{open.accountName}</span>
            <span className="text-xs text-zinc-500">· {open.taxYear}</span>
          </div>
          <button
            type="button"
            onClick={() => setOpen(null)}
            className="text-xs font-medium text-blue-600 hover:text-blue-700 shrink-0"
          >
            Change client / year
          </button>
        </div>
        <TaxFinancialsReview accountId={open.accountId} taxYear={open.taxYear} locale="en" mode="staff" />
      </div>
    )
  }

  const yearNum = Number(year)
  const canOpen = !!accountId && Number.isInteger(yearNum) && yearNum >= 2000 && yearNum <= 2100

  return (
    <div className="rounded-xl border bg-white p-6 space-y-5 max-w-2xl">
      <div>
        <label className="block text-sm font-medium text-zinc-700 mb-1">Client account</label>
        <AccountCombobox
          value={accountId}
          displayValue={accountName}
          onChange={(id, name) => { setAccountId(id); setAccountName(name) }}
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-zinc-700 mb-1">Tax year</label>
        <input
          type="number" value={year} onChange={e => setYear(e.target.value)} min={2000} max={2100}
          className="w-40 h-10 rounded-md border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => canOpen && setOpen({ accountId: accountId!, accountName: accountName ?? 'Client', taxYear: yearNum })}
        className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        Open financials
      </button>
      <p className="text-xs text-muted-foreground">
        Opens the full financials review for this client and year — upload their bank statements
        (PDF or CSV) and prior-year return, review the categorization and gates, then download the
        P&amp;L + Balance Sheet. Statements are saved to the client&apos;s records.
      </p>
    </div>
  )
}
