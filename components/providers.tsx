'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { HelpProvider } from '@/components/help/help-provider'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30 * 1000, // 30 seconds
            refetchOnWindowFocus: false,
            // OFF, deliberately — this line closes a live quota hole that had
            // been open the whole time. Left undefined, react-query defaults it
            // to TRUE, so EVERY stale query refetched on every `online` event:
            // a wifi→cellular handoff, a lift, a tunnel. That included the
            // Gmail-backed inbox queries, and the default INBOX list issues
            // ~300 live Gmail metadata calls per load — the exact pattern that
            // has already starved the per-user Gmail quota and blanked the
            // inbox (docs/systems/inbox.md). Two Council reviewers found this
            // independently while reviewing an unrelated change; nothing in the
            // app ever opted out, because nobody knew it was on.
            //
            // Catching up after a reconnect is now the wake listener's job
            // (components/shared/wake-listener.tsx), which refreshes a NAMED,
            // cost-vetted set instead of everything that happens to be stale.
            refetchOnReconnect: false,
          },
        },
      })
  )

  return (
    <QueryClientProvider client={queryClient}>
      <HelpProvider>{children}</HelpProvider>
    </QueryClientProvider>
  )
}
