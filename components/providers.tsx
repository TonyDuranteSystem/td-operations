'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { HelpProvider } from '@/components/help/help-provider'
import { REFRESH_ON_FOCUS_QUERY_KEYS } from '@/lib/query/refresh-on-focus'

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30 * 1000, // 30 seconds
          // Stays OFF as the global default — deliberately. Flipping this ON
          // app-wide is the tempting version of "make the CRM refresh itself",
          // and it is the dangerous one: it silently opts in every future query,
          // including any that calls Gmail. See lib/query/refresh-on-focus.ts
          // for the full reasoning and the opt-in list applied below.
          refetchOnWindowFocus: false,
        },
      },
    })

    // Opt IN the queries that are cheap (our DB only) and go stale while the
    // user is away. Matching is by query-key PREFIX, so 'portal-chat-threads'
    // covers ['portal-chat-threads', accountId, ...].
    //
    // This is what makes the CRM catch up when Antonio brings his phone PWA
    // back to the front: without it, every screen kept showing whatever it had
    // when he left.
    for (const key of REFRESH_ON_FOCUS_QUERY_KEYS) {
      client.setQueryDefaults([key], { refetchOnWindowFocus: true })
    }

    return client
  })

  return (
    <QueryClientProvider client={queryClient}>
      <HelpProvider>{children}</HelpProvider>
    </QueryClientProvider>
  )
}
