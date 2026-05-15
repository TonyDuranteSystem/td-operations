/**
 * Catalog cache — in-memory store of catalog_entries keyed by (catalog_id, slug).
 *
 * Purpose: avoid hitting the DB on every workflow task creation / task render.
 * Invalidation: Supabase realtime subscription to catalog_entries — on
 * UPDATE/INSERT/DELETE, the affected key is purged. The Slice 1 migration
 * added catalog_entries to the supabase_realtime publication so this works.
 *
 * Scope: server-side only. One cache per Node.js process. Cold starts re-warm
 * lazily on first access. The realtime subscription is opened lazily on the
 * first read and stays open for the lifetime of the process.
 *
 * Test environments should set TD_DISABLE_CATALOG_REALTIME=1 to skip the
 * websocket connection.
 *
 * Not used at Slice 1 — registered scaffolding. First real consumer is Slice 4
 * (auto-chain reads the itin_review row when creating a workflow task).
 *
 * See: sysdoc 'workflows-system-master-plan' §Architecture/Catalog cache.
 */

import { createClient, type RealtimeChannel } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"

/** Stored entry shape — minimal slice of catalog_entries the cache exposes. */
export interface CachedCatalogEntry {
  id: string
  catalog_id: string
  slug: string
  display_name: string
  status: "active" | "deprecated" | "exception_only"
  tags: string[]
  metadata: Record<string, unknown>
}

type CacheKey = string // `${catalog_id}::${slug}`

function cacheKey(catalogId: string, slug: string): CacheKey {
  return `${catalogId}::${slug}`
}

// Module-level state — singleton per Node.js process.
const cache = new Map<CacheKey, CachedCatalogEntry>()
// Retained reference to keep the websocket subscription alive for the
// lifetime of the process. Underscore-prefixed because we only write to it.
let _realtimeChannel: RealtimeChannel | null = null
let realtimeInitAttempted = false

function ensureRealtimeSubscription(): void {
  if (realtimeInitAttempted) return
  realtimeInitAttempted = true

  if (process.env.TD_DISABLE_CATALOG_REALTIME === "1") return

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    // Fall back silently — TTL is not implemented; consumers will see stale
    // data only across catalog edits. Log so this is visible in ops.
    console.warn("[catalog-cache] Missing Supabase env — realtime invalidation disabled")
    return
  }

  const client = createClient(url, serviceKey, {
    realtime: { params: { eventsPerSecond: 10 } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  _realtimeChannel = client
    .channel("catalog-cache-invalidation")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "catalog_entries" },
      (payload) => {
        const row = (payload.new ?? payload.old) as Partial<CachedCatalogEntry> | undefined
        if (!row?.catalog_id || !row.slug) return
        cache.delete(cacheKey(row.catalog_id, row.slug))
      },
    )
    .subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn(`[catalog-cache] Realtime channel ${status} — cache may serve stale data`)
      }
    })
}

/** Fetch a single catalog entry, using the cache when present. Returns null if not found. */
export async function getCatalogEntry(
  catalogId: string,
  slug: string,
): Promise<CachedCatalogEntry | null> {
  ensureRealtimeSubscription()

  const key = cacheKey(catalogId, slug)
  const cached = cache.get(key)
  if (cached) return cached

  const { data, error } = await supabaseAdmin
    .from("catalog_entries")
    .select("id, catalog_id, slug, display_name, status, tags, metadata")
    .eq("catalog_id", catalogId)
    .eq("slug", slug)
    .maybeSingle()

  if (error) throw new Error(`getCatalogEntry(${catalogId}, ${slug}): ${error.message}`)
  if (!data) return null

  const entry: CachedCatalogEntry = {
    id: data.id,
    catalog_id: data.catalog_id,
    slug: data.slug,
    display_name: data.display_name,
    status: data.status as CachedCatalogEntry["status"],
    tags: (data.tags as string[] | null) ?? [],
    metadata: (data.metadata as Record<string, unknown> | null) ?? {},
  }
  cache.set(key, entry)
  return entry
}

/** List all entries for a catalog id. Bypasses the cache — used by /catalog UI and the exhaustiveness test. */
export async function listCatalogEntries(
  catalogId: string,
): Promise<CachedCatalogEntry[]> {
  const { data, error } = await supabaseAdmin
    .from("catalog_entries")
    .select("id, catalog_id, slug, display_name, status, tags, metadata")
    .eq("catalog_id", catalogId)
    .order("slug", { ascending: true })

  if (error) throw new Error(`listCatalogEntries(${catalogId}): ${error.message}`)
  return (data ?? []).map((row) => ({
    id: row.id,
    catalog_id: row.catalog_id,
    slug: row.slug,
    display_name: row.display_name,
    status: row.status as CachedCatalogEntry["status"],
    tags: (row.tags as string[] | null) ?? [],
    metadata: (row.metadata as Record<string, unknown> | null) ?? {},
  }))
}

/** Drop a single key. Mainly for tests. */
export function _invalidateCatalogEntry(catalogId: string, slug: string): void {
  cache.delete(cacheKey(catalogId, slug))
}

/** Clear the entire cache. Mainly for tests. */
export function _clearCatalogCache(): void {
  cache.clear()
}

/** Current cache size. For diagnostics / tests. */
export function _catalogCacheSize(): number {
  return cache.size
}
