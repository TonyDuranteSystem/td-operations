/**
 * Calendar → "Applications to review": bank applications a client has submitted that are still on our desk. SERVER component.
 * Each row opens the application on the staff page (answers, documents, and the Reviewed / Submit / Send back buttons live
 * there, in one place). null = the list could not be read (never shown as "nothing waiting").
 */

import Link from 'next/link'
import { REVIEW_STATE_TEXT } from '@/lib/bofa-intake/review-state'
import type { WaitingApplication } from '@/lib/bofa-intake/waiting'

function when(iso: string | null): string {
  if (!iso) return 'unknown time'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { timeZone: 'Europe/Rome', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const STATE_CLS: Record<string, string> = {
  needs_review: 'bg-amber-100 text-amber-800',
  ready: 'bg-blue-100 text-blue-800',
  sending: 'bg-amber-100 text-amber-800',
  send_failed: 'bg-red-100 text-red-700',
}

export function ApplicationsToReviewTab({ rows }: { rows: WaitingApplication[] | null }) {
  if (!rows) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
        <p className="font-medium">Could not load the bank applications waiting for review.</p>
        <p className="mt-1">Nothing was changed. This is not &quot;nothing waiting&quot;: reload, or open the Forms page and its list of submissions.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        A client submitted these. <b>Nothing has been sent to the bank contact.</b> Open one, look at the answers and documents, press <b>Reviewed</b>,
        then <b>Submit</b>. If something is wrong, <b>Send back</b> gives the client a new link and your message. An application leaves this list when it is submitted or sent back.
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border px-4 py-6 text-center text-sm text-zinc-600">No application is waiting for review.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map(r => (
            <li key={r.id} className="rounded-lg border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="text-base font-semibold">{r.applicant || 'Applicant'}{r.company ? ` — ${r.company}` : ''}</p>
                  <p className="text-sm text-zinc-600">
                    {r.partner ? `Partner: ${r.partner}` : 'Direct (no partner)'} · submitted {when(r.completedAt)}
                  </p>
                </div>
                <span className={`rounded px-2 py-0.5 text-xs ${STATE_CLS[r.state] ?? 'bg-zinc-100 text-zinc-700'}`}>{REVIEW_STATE_TEXT[r.state]}</span>
              </div>
              {r.state === 'send_failed' && r.error && <p className="mt-2 text-sm text-red-700">The last submit did not go through: {r.error}</p>}
              <div className="mt-3">
                <Link href={`/bofa-intake?open=${r.id}`} prefetch={false} className="inline-flex h-9 items-center rounded-md border px-4 text-sm hover:bg-zinc-50">
                  Open the application
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
