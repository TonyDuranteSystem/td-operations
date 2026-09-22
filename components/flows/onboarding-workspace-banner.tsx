'use client'

import { useState } from 'react'
import { ClipboardCheck, ChevronDown, ChevronUp } from 'lucide-react'
import { OnboardingReviewDetail } from '@/app/(dashboard)/onboarding-review/components/onboarding-review-list'
import { ActivateRa } from '@/components/flows/activate-ra'
import type { OnboardingReviewEntry } from '@/app/(dashboard)/onboarding-review/page'

/**
 * Onboarding Workspace — the per-client counterpart to FormationWorkspaceBanner
 * / ItinWorkspaceBanner / TaxWorkspaceBanner, so staff review a client's
 * onboarding submission right on the client's own page instead of only in the
 * global /onboarding-review inbox (Antonio, 2026-09-22: "the staff must have
 * the workspace onboarding on the client page in order to review everything
 * that the client sent"). Inlined rather than a separate /flows/[id] page —
 * Client Onboarding isn't a recurring/date-driven flow type like Tax Return
 * or a pre-existing-entity type like Formation/ITIN, so it doesn't fit the
 * generic flow-resolver's assumptions; this is a self-contained equivalent.
 *
 * Two states, both real per Antonio's explicit instruction:
 *   1. PENDING — a submission exists, nothing created yet. Embeds the exact
 *      same review UI (data + documents + Confirm) as the global inbox.
 *   2. REVIEWED — staff confirmed, the account/SD now exist. Shows the next
 *      real step: switch the Registered Agent to Harbor Compliance — the
 *      actual in-workflow action, not the generic top-of-page HC bookmark
 *      link Antonio was rightly confused by earlier.
 */
export function OnboardingWorkspaceBanner({
  pendingEntries,
  reviewed,
}: {
  pendingEntries: OnboardingReviewEntry[]
  reviewed: { companyName: string | null; serviceDeliveryId: string; accountId: string | null }[]
}) {
  if (pendingEntries.length === 0 && reviewed.length === 0) return null

  return (
    <div className="mb-4 space-y-3">
      {pendingEntries.map((entry) => (
        <PendingCard key={entry.id} entry={entry} />
      ))}
      {reviewed.map((r) => (
        <div key={r.serviceDeliveryId} className="rounded-xl border-2 border-indigo-300 bg-indigo-50 p-4">
          <div className="mb-3 flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-600">
              <ClipboardCheck className="h-5 w-5 text-white" />
            </div>
            <div>
              <p className="text-sm font-semibold text-indigo-900">
                Onboarding reviewed{r.companyName ? ` — ${r.companyName}` : ''}
              </p>
              <p className="text-xs text-indigo-700">Next step: switch the Registered Agent.</p>
            </div>
          </div>
          <ActivateRa serviceDeliveryId={r.serviceDeliveryId} accountId={r.accountId} mode="switch" />
        </div>
      ))}
    </div>
  )
}

function PendingCard({ entry }: { entry: OnboardingReviewEntry }) {
  const [expanded, setExpanded] = useState(true)
  const companyName = (entry.submitted_data.company_name as string) || 'Unnamed company'

  return (
    <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 text-left"
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-600">
          <ClipboardCheck className="h-5 w-5 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-900">
            Onboarding — {companyName} — awaiting your review
          </p>
          <p className="text-xs text-amber-700">
            Submitted by {entry.lead_name || 'the client'}. Nothing has been created yet — check the data and
            documents below, then confirm.
          </p>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-amber-500" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-amber-500" />
        )}
      </button>
      {expanded && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-white p-3">
          <OnboardingReviewDetail entry={entry} />
        </div>
      )}
    </div>
  )
}
