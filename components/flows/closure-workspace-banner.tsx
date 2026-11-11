import Link from 'next/link'
import { DoorClosed, ArrowRight } from 'lucide-react'

/**
 * Prominent, top-of-page banner linking to a Company Closure flow Workspace. Mirrors FormationWorkspaceBanner /
 * ItinWorkspaceBanner for a closure on a PERSON (account_id NULL — the company being closed is often not one of
 * ours, so there is no company page to open it from) and for a closure of a company of ours, so staff always have
 * one click from the contact to the closure workspace: the client's answers and documents, and every step.
 * A contract that closes several companies has several jobs, so this is drawn once per job — `companyName`
 * (known once the client has filled the form) and the stage tell them apart.
 * Plain server component (just a Link + markup). Dev job 9829a468.
 */
export function ClosureWorkspaceBanner({
  serviceDeliveryId,
  stage,
  companyName,
  unitLabel,
}: {
  serviceDeliveryId: string
  stage?: string | null
  /** The company being closed, when the client's form (or the CRM company) names it. */
  companyName?: string | null
  /** "#2" when the contract closes several companies — tells the job cards apart before the form names the company. */
  unitLabel?: string | null
}) {
  return (
    <Link
      href={`/flows/${serviceDeliveryId}`}
      className="group mb-4 flex items-center gap-4 rounded-xl border-2 border-rose-300 bg-rose-50 p-4 transition-colors hover:bg-rose-100"
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-600">
        <DoorClosed className="h-6 w-6 text-white" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-rose-900">
          Company Closure{unitLabel ? ` ${unitLabel}` : ''} in progress{companyName ? ` — ${companyName}` : ''}
        </p>
        <p className="mt-0.5 text-sm text-rose-700">
          {stage ? `Current stage: ${stage}` : 'Open the closure workspace'}
        </p>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white">
        Open workspace
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  )
}
