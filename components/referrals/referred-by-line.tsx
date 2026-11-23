'use client'

/**
 * "Referred by …" line for the company page — STAFF ONLY (the CRM dashboard; never rendered in the client portal).
 * Self-contained like ReferralsGivenCard: fetches on mount, renders nothing while loading and nothing when the
 * company was not referred, so it can sit on every company page harmlessly.
 */
import { useEffect, useState } from 'react'
import { Share2 } from 'lucide-react'

export function ReferredByLine({ accountId }: { accountId: string }) {
  const [referrers, setReferrers] = useState<string[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/referral/referred-by?accountId=${accountId}`)
      .then(res => (res.ok ? res.json() : { referrers: [] }))
      .then(data => { if (!cancelled) setReferrers(Array.isArray(data.referrers) ? data.referrers : []) })
      .catch(() => { if (!cancelled) setReferrers([]) })
    return () => { cancelled = true }
  }, [accountId])

  if (!referrers || referrers.length === 0) return null

  return (
    <div
      data-testid="referred-by-line"
      className="col-span-full flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm text-sky-900"
      title="Staff only — the client does not see this."
    >
      <Share2 className="h-4 w-4 shrink-0 text-sky-500" />
      <span>
        Referred by <span className="font-semibold">{referrers.join(', ')}</span>
      </span>
    </div>
  )
}
