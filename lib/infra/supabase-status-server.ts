/**
 * Reads Supabase's public status feed (server only). The address can be changed with SUPABASE_STATUS_FEED_URL (a test points it at a fake feed);
 * a feed that cannot be read answers `null` ("unknown") — never "all clear": a wrong all-clear is worse than silence.
 * Cached for a minute in this server's memory so a page full of staff does not hit the feed.
 */
import { DEFAULT_SUPABASE_REGION, type FeedIncident } from '@/lib/infra/supabase-status'

const DEFAULT_FEED = 'https://status.supabase.com/api/v2/incidents.json'
const CACHE_MS = 60_000
let cache: { at: number; url: string; feed: FeedIncident[] | null } | null = null

export function supabaseRegion(): string {
  return (process.env.SUPABASE_REGION ?? '').trim() || DEFAULT_SUPABASE_REGION
}

export async function fetchSupabaseFeed(opts: { fresh?: boolean } = {}): Promise<FeedIncident[] | null> {
  const url = (process.env.SUPABASE_STATUS_FEED_URL ?? '').trim() || DEFAULT_FEED
  if (!opts.fresh && cache && cache.url === url && Date.now() - cache.at < CACHE_MS) return cache.feed
  let feed: FeedIncident[] | null = null
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
      if (res.ok) {
        const d = await res.json() as { incidents?: FeedIncident[] }
        feed = Array.isArray(d.incidents) ? d.incidents : null
      }
    } finally { clearTimeout(timer) }
  } catch { feed = null }
  cache = { at: Date.now(), url, feed }
  return feed
}

export function resetSupabaseFeedCache(): void { cache = null }
