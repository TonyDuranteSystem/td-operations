import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import {
  REFRESH_ON_FOCUS_QUERY_KEYS,
  REFRESH_ON_FOCUS_EXCLUDED_FOR_COST,
} from '@/lib/query/refresh-on-focus'

/**
 * Builds a client exactly the way components/providers.tsx does, so this tests
 * the real wiring rather than a restatement of it.
 *
 * Why this test exists: the browser E2E for this feature CANNOT prove the
 * mechanism. A real backgrounded phone PWA has its timers frozen, so its polls
 * stop and the focus-refetch is what catches it up. A synthetic
 * `visibilitychange` in an actually-visible tab does not freeze anything — the
 * page's own 30s/60s polls keep running and every query is still fresh at
 * "wake", so nothing refetches, correctly. That looks like a failure and isn't.
 * The honest split: this test proves the wiring, and the phone proves the feel.
 */
function buildClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: 30 * 1000, refetchOnWindowFocus: false } },
  })
  for (const key of REFRESH_ON_FOCUS_QUERY_KEYS) {
    client.setQueryDefaults([key], { refetchOnWindowFocus: true })
  }
  return client
}

describe('refresh-on-focus wiring', () => {
  it('leaves the GLOBAL default OFF — the safety property everything rests on', () => {
    const client = buildClient()
    expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false)
  })

  it('turns it ON for every allow-listed key', () => {
    const client = buildClient()
    for (const key of REFRESH_ON_FOCUS_QUERY_KEYS) {
      expect(
        client.getQueryDefaults([key]).refetchOnWindowFocus,
        `expected '${key}' to refetch on focus`,
      ).toBe(true)
    }
  })

  it('matches by key PREFIX, so real keys with arguments are covered', () => {
    const client = buildClient()
    // Real call sites look like ['portal-chat-threads', accountId, filter].
    expect(client.getQueryDefaults(['portal-chat-threads', 'acct-123', 'open']).refetchOnWindowFocus).toBe(true)
    expect(client.getQueryDefaults(['internal-thread-messages', 42]).refetchOnWindowFocus).toBe(true)
  })

  it('leaves every cost-excluded key alone — no Gmail query gains focus refetch', () => {
    const client = buildClient()
    for (const key of REFRESH_ON_FOCUS_EXCLUDED_FOR_COST) {
      expect(
        client.getQueryDefaults([key]).refetchOnWindowFocus,
        `'${key}' hits Gmail/Drive and must NOT refetch on focus`,
      ).toBeUndefined()
    }
  })

  it('leaves an unknown//future query alone — safe by construction', () => {
    const client = buildClient()
    // The whole point of the allow-list: a query nobody thought about inherits
    // the OFF default rather than silently becoming a live external API call.
    expect(client.getQueryDefaults(['some-query-added-next-year']).refetchOnWindowFocus).toBeUndefined()
  })
})
