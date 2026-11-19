import Link from 'next/link'
import { ArrowRight, Replace } from 'lucide-react'

/**
 * Shown at the top of a CANCELLED Company Formation workspace whose company was replaced by "The state refused the company name?"
 * (dev job bf9886a3). It is drawn by the server from the new job's own note, so it is there on every visit and survives the dashboard's
 * automatic page refreshes — the way to the new job never depends on the page staying as it was after the press. Plain server component.
 */
export function ReplacedByCard({ newJobId, stage, status }: { newJobId: string; stage?: string | null; status?: string | null }) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-4 rounded-xl border-2 border-emerald-300 bg-emerald-50 p-4" data-testid="replaced-by-card">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600">
        <Replace className="h-6 w-6 text-white" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-emerald-900">This formation was replaced by a new one</p>
        <p className="mt-0.5 text-sm text-emerald-800">
          The state refused the company name, so a new formation was started for the same person on the same paid offer.
          {stage ? ` The new job is at: ${stage}${status && status !== 'active' ? ` (${status})` : ''}.` : ''}
        </p>
      </div>
      <Link
        href={`/flows/${newJobId}`}
        data-testid="replaced-by-open"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
      >
        Open the new formation job
        <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  )
}
