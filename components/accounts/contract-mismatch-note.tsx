/**
 * The amber note on a company's page when a signed contract's amounts do not match the company's own installment amounts (dev job a2a663cf,
 * Antonio 2026-11-15: "the amber should go on the account as well, above all if the amber is related to the company").
 *
 * The same finding, in the same words, as the amber note on the Contact page and the hover card on the Accounts list (the words come from
 * `contractAlert`). Nothing here is stored and there is no button to hide it: the page asks again every time it opens, so the note is gone
 * as soon as the company's amounts match the contract (or the contract is corrected). It says which numbers differ, not which side is wrong.
 */
import { TriangleAlert } from 'lucide-react'
import { contractAlert } from '@/lib/crm-lists/hover-cards'
import type { ContractMismatch } from '@/lib/signed-contracts/types'

export function ContractMismatchNote({ findings }: { /** null = the check could not run just now */ findings: ContractMismatch[] | null }) {
  if (findings === null) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="contract-mismatch-failed">
        Could not check the signed contract amounts just now. Reload the page to try again.
      </p>
    )
  }
  const alert = contractAlert(findings, { forCompany: true })
  if (!alert) return null
  return (
    <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="contract-mismatch-note">
      <p className="flex items-center gap-1.5 font-semibold">
        <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        {alert.heading}
      </p>
      {alert.blocks.map((b, i) => (
        <div key={i}>
          <p className="font-medium">{b.title}</p>
          {b.lines.map((line, j) => (
            <p key={j} className="text-amber-800">
              {line}
            </p>
          ))}
        </div>
      ))}
      <p className="text-xs text-amber-700">
        Correct whichever one is wrong: this company&apos;s installment amounts, or the contract (the Edit button on the contact&apos;s Signed contracts card).
      </p>
    </div>
  )
}
