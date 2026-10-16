'use client'

import { useQuery } from '@tanstack/react-query'
import type { WhatsNewSummary } from '@/lib/notifications/whats-new-summary'

export const WHATS_NEW_SUMMARY_KEY = ['portal-chat-whats-new-counts', 'summary'] as const

/**
 * The cross-client What's New summary (GET /api/crm/admin-actions/whats-new?summary=true). It sits under the same query-key
 * prefix as the purple dot's counts, so ticking a note "Handled" anywhere (Portal Chats or this tab) refreshes both.
 * Server errors are shown, not swallowed (R099).
 */
export function useWhatsNewSummary() {
  return useQuery<WhatsNewSummary>({
    queryKey: WHATS_NEW_SUMMARY_KEY,
    queryFn: async () => {
      const res = await fetch('/api/crm/admin-actions/whats-new?summary=true', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((data as { error?: string }).error || "Could not read What's New. Please try again.")
      // A 200 that is not the summary (a login redirect, an HTML page) must be an error, not a crash on `.clients`.
      const d = data as Partial<WhatsNewSummary>
      if (!Array.isArray(d.clients) || typeof d.total !== 'number') throw new Error("Could not read What's New. Please reload the page.")
      return d as WhatsNewSummary
    },
    refetchInterval: 30_000,
  })
}
