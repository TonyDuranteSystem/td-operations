import Link from 'next/link'
import { ClipboardCheck, ArrowRight } from 'lucide-react'
import type { OnboardingReviewEntry } from '@/app/(dashboard)/onboarding-review/page'
import type { ReviewedOnboarding } from '@/lib/flows/resolve-onboarding-workspace'

/**
 * Compact, top-of-page banner linking to the Onboarding Workspace — same
 * shape and placement as FormationWorkspaceBanner / ItinWorkspaceBanner /
 * TaxWorkspaceBanner, not an inline dump (Antonio, 2026-09-22, correcting an
 * earlier miss: "Can you do this fucking workspace, like ITIN, formation, or
 * tax return?"). One banner per pending or just-reviewed onboarding; each
 * links to app/(dashboard)/onboarding-review/[id]/page.tsx, the real
 * workspace with the full data/documents/review/Registered-Agent stages.
 */
export function OnboardingWorkspaceBanner({
  pendingEntries,
  reviewed,
}: {
  pendingEntries: OnboardingReviewEntry[]
  reviewed: ReviewedOnboarding[]
}) {
  if (pendingEntries.length === 0 && reviewed.length === 0) return null

  return (
    <div className="mb-4 space-y-2">
      {pendingEntries.map((entry) => {
        const companyName = (entry.submitted_data.company_name as string) || 'Unnamed company'
        return (
          <Link
            key={entry.id}
            href={`/onboarding-review/${entry.id}`}
            className="group flex items-center gap-4 rounded-xl border-2 border-amber-300 bg-amber-50 p-4 transition-colors hover:bg-amber-100"
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-600">
              <ClipboardCheck className="h-6 w-6 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-900">Onboarding submitted — {companyName}</p>
              <p className="mt-0.5 text-sm text-amber-700">Awaiting your review</p>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white">
              Open workspace
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        )
      })}
      {reviewed.map((r) => (
        <Link
          key={r.serviceDeliveryId}
          href={`/onboarding-review/${r.submissionId}`}
          className="group flex items-center gap-4 rounded-xl border-2 border-indigo-300 bg-indigo-50 p-4 transition-colors hover:bg-indigo-100"
        >
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-600">
            <ClipboardCheck className="h-6 w-6 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-indigo-900">
              Onboarding reviewed{r.companyName ? ` — ${r.companyName}` : ''}
            </p>
            <p className="mt-0.5 text-sm text-indigo-700">Next step: switch the Registered Agent</p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white">
            Open workspace
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
      ))}
    </div>
  )
}
