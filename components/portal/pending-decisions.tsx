'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { DecisionCard } from '@/components/portal/decision-card'
import type { DecisionRequest } from '@/lib/decisions'
import { useLocale } from '@/lib/portal/use-locale'

/**
 * Portal-wide pending decision requests. Fetches the signed-in client's pending
 * requests (GET /api/portal/my-decisions) and renders them as actionable cards
 * at the top of the portal content. Self-hiding: renders nothing when there are
 * none, so it only appears when the client actually has something to answer
 * (e.g. an LLC name approval). This is the dashboard surface for Client Decision
 * Requests — they're no longer buried on the flow detail page only.
 */
export function PendingDecisions({ locale }: { locale: 'en' | 'it' }) {
  const [requests, setRequests] = useState<DecisionRequest[]>([])
  const { t } = useLocale()
  // On a flow's own page the card is shown there, under the progress — repeating it up here showed the same "Action required"
  // card twice (production QA, 2026-10-20). Requests of OTHER services still show.
  const flowId = usePathname()?.match(/^\/portal\/flows\/([0-9a-f-]{36})/i)?.[1] ?? null

  useEffect(() => {
    let cancelled = false
    fetch('/api/portal/my-decisions')
      .then((r) => r.json())
      .then((d: { requests?: DecisionRequest[] }) => {
        if (!cancelled) setRequests(d.requests ?? [])
      })
      .catch(() => {
        /* non-critical — the request also lives on the flow page */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const shown = flowId ? requests.filter((r) => r.service_delivery_id !== flowId) : requests
  if (shown.length === 0) return null

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto pb-0 space-y-3">
      <h2 className="px-1 text-sm font-semibold uppercase tracking-wide text-amber-700">
        {t('decisions.actionRequired')}
      </h2>
      {shown.map((req) => (
        <DecisionCard key={req.id} request={req} locale={locale} actionable />
      ))}
    </div>
  )
}
