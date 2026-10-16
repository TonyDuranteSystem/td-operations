'use client'

import { useWhatsNewSummary } from '@/components/whats-new/use-whats-new-summary'

/** The purple number on the New Calendar's What's New tab: the same unhandled-note count as the purple dot in the left menu. */
export function WhatsNewCount() {
  const { data } = useWhatsNewSummary()
  if (!data || data.total <= 0) return null
  return (
    <span className="ml-1 rounded-full bg-purple-600 px-2 py-0.5 font-mono text-xs font-semibold text-white" aria-label={`${data.total} new`}>
      {data.total}
    </span>
  )
}
