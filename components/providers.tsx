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
            // ON since 2026-07-22. This single line was why the CRM never
            // caught up when Antonio brought his phone PWA back to the front:
            // every query deliberately ignored the return-to-app. Combined with
            // realtime sockets that die during background suspension and never
            // reconnected, a foregrounded app showed confidently stale data
            // until a manual reload. staleTime above bounds the cost — a focus
            // within 30s of the last fetch still refetches nothing.
            //
            // Any query whose refetch is EXPENSIVE must opt out locally rather
            // than flipping this back off. Precedent: the inbox conversation
            // list (~300 live Gmail metadata calls per load) sets
            // refetchOnWindowFocus:false on itself — see conversation-list.tsx.
            refetchOnWindowFocus: true,
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
