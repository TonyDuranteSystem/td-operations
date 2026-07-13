/**
 * Conversation buckets — Team Chat Conversations sidebar (dev_task be582c5e, Phase 1).
 *
 * The `client_bucket` value is computed SERVER-SIDE by `get_team_threads`
 * (see migration 20260712-1600-team-threads-client-bucket.sql). This module is
 * the pure client-side vocabulary: the section order, the per-bucket badge text
 * + colour, which sections open by default, and the grouping helper that turns
 * the flat per-client groups into ordered top-level sections.
 *
 * Kept free of React/DOM so it is unit-testable and reusable.
 */

export type BucketKey =
  | 'active_client'
  | 'lead'
  | 'partner'
  | 'individual'
  | 'suspended'
  | 'cancelled'
  | 'offboarded'
  | 'internal'

export interface BucketMeta {
  key: BucketKey
  /** Top-level section header label. */
  section: string
  /** Short badge shown next to each conversation. */
  badge: string
  /** Tailwind classes for the badge pill. */
  badgeClass: string
  /** Whether the section is expanded by default (inactive states collapse). */
  defaultOpen: boolean
}

/** Ordered — this IS the section render order. */
export const CONVERSATION_BUCKETS: BucketMeta[] = [
  { key: 'active_client', section: 'Active clients', badge: 'Active',      badgeClass: 'bg-emerald-100 text-emerald-700', defaultOpen: true },
  { key: 'lead',          section: 'Leads',          badge: 'Lead',        badgeClass: 'bg-blue-100 text-blue-700',       defaultOpen: true },
  { key: 'partner',       section: 'Partners',       badge: 'Partner',     badgeClass: 'bg-violet-100 text-violet-700',   defaultOpen: true },
  { key: 'individual',    section: 'Individuals',    badge: 'Individual',  badgeClass: 'bg-teal-100 text-teal-700',       defaultOpen: true },
  { key: 'suspended',     section: 'Suspended',      badge: 'Suspended',   badgeClass: 'bg-amber-100 text-amber-700',     defaultOpen: false },
  { key: 'cancelled',     section: 'Cancelled',      badge: 'Cancelled',   badgeClass: 'bg-orange-100 text-orange-700',   defaultOpen: false },
  { key: 'offboarded',    section: 'Off-boarded',    badge: 'Off-boarded', badgeClass: 'bg-zinc-200 text-zinc-600',       defaultOpen: false },
  { key: 'internal',      section: 'Internal',       badge: 'Internal',    badgeClass: 'bg-zinc-100 text-zinc-500',       defaultOpen: false },
]

export const BUCKET_META: Record<BucketKey, BucketMeta> = Object.fromEntries(
  CONVERSATION_BUCKETS.map(m => [m.key, m]),
) as Record<BucketKey, BucketMeta>

export const DEFAULT_OPEN_BUCKETS: BucketKey[] = CONVERSATION_BUCKETS.filter(m => m.defaultOpen).map(m => m.key)

/** Minimal shape this module needs off a thread. */
interface ThreadLike {
  client_bucket?: string | null
  lead_status?: string | null
}
/** A per-client group as built by the sidebar (client_key → its threads). */
export interface ClientGroupLike<T extends ThreadLike = ThreadLike> {
  key: string
  label: string
  threads: T[]
}

/**
 * Resolve a client group's bucket from its first thread (all threads in a group
 * share the same client, hence the same bucket). Unknown / missing → 'internal'.
 */
export function bucketKeyOf(group: ClientGroupLike): BucketKey {
  const b = group.threads[0]?.client_bucket
  return b != null && b in BUCKET_META ? (b as BucketKey) : 'internal'
}

/**
 * Group the flat per-client groups into ordered top-level sections. Preserves
 * each group's incoming order within its section (the RPC returns newest-first)
 * and drops empty sections.
 */
export function groupIntoSections<T extends ThreadLike, G extends ClientGroupLike<T>>(
  groups: G[],
): { meta: BucketMeta; groups: G[] }[] {
  const byKey = new Map<BucketKey, G[]>()
  for (const g of groups) {
    const k = bucketKeyOf(g)
    const arr = byKey.get(k)
    if (arr) arr.push(g)
    else byKey.set(k, [g])
  }
  return CONVERSATION_BUCKETS.filter(m => byKey.has(m.key)).map(m => ({ meta: m, groups: byKey.get(m.key)! }))
}

/**
 * Badge text for a group — the bucket badge, except leads append their pipeline
 * stage when present (e.g. "Lead · Offer Sent").
 */
export function badgeTextFor(group: ClientGroupLike): string {
  const meta = BUCKET_META[bucketKeyOf(group)]
  if (meta.key === 'lead') {
    const stage = group.threads[0]?.lead_status
    if (stage) return `Lead · ${stage}`
  }
  return meta.badge
}
