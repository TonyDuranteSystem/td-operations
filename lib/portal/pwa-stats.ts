/**
 * PWA adoption stats for staff (Phase 2 of install adoption, dev job 8f38add1).
 *
 * THE RULE (council D6b): per-account "receiving push" is derived LIVE from
 * `push_subscriptions` — self-pruning (dead endpoints are deleted on send,
 * lib/portal/web-push.ts), per-account, and it is the metric that matters:
 * an installed app with notifications off delivers nothing on iOS.
 * `pwa_events` feeds the FUNNEL numbers only (visits per channel, Android
 * installs, launches) and makes no per-account truth claims.
 *
 * iOS attribution caveat (D6c, honest by design): iOS fires no appinstalled
 * event and partitions storage, so per-channel install counts exist only for
 * Android; iOS installs appear as (un-attributed) standalone launches. The
 * staff card states this — never fake per-channel precision for iPhone.
 *
 * Aggregation is a pure function (derivePwaFunnel) for unit tests.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import type { PwaEventName } from './pwa-events'

export interface PwaFunnelRow {
  event: string
  src: string | null
}

export interface PwaFunnel {
  pageViews: number
  pageViewsBySrc: Record<string, number>
  installsAndroid: number
  standaloneLaunches: number
  standaloneAuthenticated: number
}

export interface PwaAdoptionStats {
  activeAccounts: number
  accountsWithPush: number
  /** 0-100, rounded to one decimal; 0 when there are no active accounts. */
  pushCoveragePct: number
  funnel30d: PwaFunnel
}

export function derivePwaFunnel(rows: PwaFunnelRow[]): PwaFunnel {
  const funnel: PwaFunnel = {
    pageViews: 0,
    pageViewsBySrc: {},
    installsAndroid: 0,
    standaloneLaunches: 0,
    standaloneAuthenticated: 0,
  }
  for (const row of rows) {
    switch (row.event as PwaEventName) {
      case 'page_view': {
        funnel.pageViews++
        const src = row.src || 'direct'
        funnel.pageViewsBySrc[src] = (funnel.pageViewsBySrc[src] || 0) + 1
        break
      }
      case 'installed':
        funnel.installsAndroid++
        break
      case 'standalone_launch':
        funnel.standaloneLaunches++
        break
      case 'standalone_authenticated':
        funnel.standaloneAuthenticated++
        break
    }
  }
  return funnel
}

export async function getPwaAdoptionStats(): Promise<PwaAdoptionStats> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const [activeRes, subsRes, eventsRes] = await Promise.all([
    // Same test-account exclusion pattern as crm_dashboard_stats.
    supabaseAdmin
      .from('accounts')
      .select('id', { count: 'exact', head: false })
      .eq('portal_tier', 'active')
      .or('is_test.is.null,is_test.eq.false'),
    supabaseAdmin
      .from('push_subscriptions')
      .select('account_id')
      .not('account_id', 'is', null),
    // pwa_events is absent from the generated types (regeneration is blocked
    // by the schema-drift decision) — same cast precedent as sysdoc_read_log.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from('pwa_events')
      .select('event, src')
      .gte('created_at', thirtyDaysAgo) as Promise<{ data: PwaFunnelRow[] | null }>,
  ])

  const activeIds = new Set((activeRes.data || []).map(a => a.id))
  // Count only subscriptions belonging to a real (non-test) ACTIVE account —
  // the denominator and numerator must describe the same population.
  const subscribedActive = new Set(
    (subsRes.data || [])
      .map(s => s.account_id as string)
      .filter(id => activeIds.has(id)),
  )

  const activeAccounts = activeIds.size
  const accountsWithPush = subscribedActive.size
  const pushCoveragePct = activeAccounts === 0
    ? 0
    : Math.round((accountsWithPush / activeAccounts) * 1000) / 10

  return {
    activeAccounts,
    accountsWithPush,
    pushCoveragePct,
    funnel30d: derivePwaFunnel(eventsRes.data || []),
  }
}
