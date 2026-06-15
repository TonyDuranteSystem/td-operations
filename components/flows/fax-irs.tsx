import Link from 'next/link'
import { Printer } from 'lucide-react'
import type { WorkspaceAccount } from './types'

/**
 * "Send Fax to IRS" action for the Tax Return "Signed" stage. Opens the Fax
 * tool (/tools/fax) pre-filled with recipient "IRS" and a cover note that
 * references the company. The IRS fax number is NOT pre-filled — it depends on
 * the form/IRS office, so staff enters it (and attaches the signed return, which
 * they download from the document viewer on this stage).
 */
export function FaxIrs({ account }: { account: WorkspaceAccount }) {
  const company = account.company_name ?? 'this client'
  const message = `Signed tax return for ${company}.`
  const href = `/tools/fax?to=${encodeURIComponent('IRS')}&message=${encodeURIComponent(message)}`

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100">
          <Printer className="h-5 w-5 text-zinc-600" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-zinc-900">Fax the signed return to the IRS</p>
          <p className="text-xs text-zinc-500 mt-1">
            Opens the Fax tool pre-filled for the IRS. Download the signed return from the documents above, then attach it and enter the IRS fax number.
          </p>
        </div>
        <Link
          href={href}
          className="shrink-0 inline-flex items-center gap-1.5 self-center rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700"
        >
          <Printer className="h-3.5 w-3.5" />
          Send Fax to IRS
        </Link>
      </div>
    </div>
  )
}
