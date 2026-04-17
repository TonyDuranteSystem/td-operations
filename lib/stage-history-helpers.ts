/**
 * P3.4 #4 — pure helpers for rendering SD stage_history entries.
 *
 * `service_deliveries.stage_history` is a jsonb array where each entry is
 * written by `advanceServiceDelivery` in lib/service-delivery.ts. Shape
 * of each entry (optional keys vary between call sites):
 *
 *   {
 *     to_stage?: string
 *     to_order?: number
 *     from_stage?: string | null
 *     from_order?: number | null
 *     advanced_at?: string   // ISO timestamp
 *     actor?: string         // who triggered the advance (MCP actor or user)
 *     notes?: string
 *   }
 *
 * Extracted to a plain .ts file so vitest can import without JSX.
 */

export interface RawStageHistoryEntry {
  to_stage?: string
  to_order?: number
  from_stage?: string | null
  from_order?: number | null
  advanced_at?: string
  actor?: string
  notes?: string
}

export interface StageHistoryEntry {
  to_stage: string
  to_order: number | null
  from_stage: string | null
  from_order: number | null
  advanced_at: string | null
  actor: string | null
  notes: string | null
}

/**
 * Normalize a raw jsonb stage_history array. Filters out rows without a
 * to_stage (malformed entries slipped in by older code paths). Returns
 * newest-first by advanced_at — entries without a timestamp sort last.
 */
export function normalizeStageHistory(
  raw: unknown,
): StageHistoryEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: StageHistoryEntry[] = []
  for (const r of raw) {
    if (!r || typeof r !== "object") continue
    const e = r as RawStageHistoryEntry
    if (!e.to_stage || typeof e.to_stage !== "string") continue
    entries.push({
      to_stage: e.to_stage,
      to_order: typeof e.to_order === "number" ? e.to_order : null,
      from_stage: typeof e.from_stage === "string" ? e.from_stage : null,
      from_order: typeof e.from_order === "number" ? e.from_order : null,
      advanced_at: typeof e.advanced_at === "string" ? e.advanced_at : null,
      actor: typeof e.actor === "string" ? e.actor : null,
      notes: typeof e.notes === "string" ? e.notes : null,
    })
  }
  entries.sort((a, b) => {
    if (!a.advanced_at && !b.advanced_at) return 0
    if (!a.advanced_at) return 1
    if (!b.advanced_at) return -1
    return b.advanced_at.localeCompare(a.advanced_at)
  })
  return entries
}

/**
 * Human-readable relative time — used by the dialog. Very rough, matches
 * the tracker card's timeAgo vocabulary.
 */
export function formatRelativeTime(
  iso: string | null,
  now: Date = new Date(),
): string {
  if (!iso) return "—"
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return "—"
  const diffMs = now.getTime() - then.getTime()
  const mins = Math.floor(diffMs / (1000 * 60))
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(days / 365)
  return `${years}y ago`
}
