import Link from 'next/link'
import { Calculator, ArrowRight } from 'lucide-react'

/**
 * Prominent, top-of-page banner linking to a Tax Return flow Workspace.
 *
 * WHY (Antonio, 2026-08-12, hit during his own QA — card c5ff8b4d Phase 1):
 * the account page had NO door into the tax room. The workspace is the ONLY
 * staff surface for tax returns — Luca opens the client, opens their tax
 * return, and works there — so the way in must be as visible as the formation
 * one, not a link buried in a tab. Same shape as FormationWorkspaceBanner on
 * purpose: one learned pattern for "this client has a live service room".
 */
export function TaxWorkspaceBanner({
  serviceDeliveryId,
  stage,
  taxYear,
  companyName,
}: {
  serviceDeliveryId: string
  stage?: string | null
  taxYear?: number | null
  companyName?: string | null
}) {
  return (
    <Link
      href={`/flows/${serviceDeliveryId}`}
      className="group mb-4 flex items-center gap-4 rounded-xl border-2 border-emerald-300 bg-emerald-50 p-4 transition-colors hover:bg-emerald-100"
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600">
        <Calculator className="h-6 w-6 text-white" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-emerald-900">
          Tax Return{taxYear ? ` ${taxYear}` : ''} in progress{companyName ? ` — ${companyName}` : ''}
        </p>
        <p className="mt-0.5 text-sm text-emerald-700">
          {stage ? `Current stage: ${stage}` : 'Open the tax workspace'}
        </p>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white">
        Open workspace
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  )
}
