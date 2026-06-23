import Link from 'next/link'
import { Building2, ArrowRight } from 'lucide-react'

/**
 * Prominent, top-of-page banner linking to a Company Formation flow Workspace.
 * Shown on the account page (active account-scoped formation SD) and the contact
 * page (contact-scoped in-progress formation SD). It's a priority CTA — staff
 * drive the whole formation from the workspace, so it sits near the top, not in
 * a tab at the bottom. Plain server component (just a Link + markup).
 */
export function FormationWorkspaceBanner({
  serviceDeliveryId,
  stage,
  companyName,
}: {
  serviceDeliveryId: string
  stage?: string | null
  companyName?: string | null
}) {
  return (
    <Link
      href={`/flows/${serviceDeliveryId}`}
      className="group mb-4 flex items-center gap-4 rounded-xl border-2 border-indigo-300 bg-indigo-50 p-4 transition-colors hover:bg-indigo-100"
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600">
        <Building2 className="h-6 w-6 text-white" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-indigo-900">
          Company Formation in progress{companyName ? ` — ${companyName}` : ''}
        </p>
        <p className="mt-0.5 text-sm text-indigo-700">
          {stage ? `Current stage: ${stage}` : 'Open the formation workspace'}
        </p>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white">
        Open workspace
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  )
}
