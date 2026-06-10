/**
 * Tax Board — pure grouping & staleness logic (Slice 6, REV 4.1 spec §6).
 *
 * The staff Kanban groups in-flight Tax Return service deliveries into columns
 * defined by the catalog (pipeline_stages.board_visible). A card's column is
 * its EFFECTIVE stage — the SD stage overlaid with review_status (shared with
 * the Slice 5 client tracker via lib/tax/tax-stage-overlay.ts) — so a
 * submission under review shows in "Under Review" instead of piling into
 * "Data Submitted" where the SD actually parks.
 *
 * Cards whose effective stage is NOT a board column (legacy/renamed stages
 * like "Filed" vs catalog "TR Filed", generic "In Progress", or pre-board
 * intake stages) are NEVER dropped — they land in a synthetic "Other" column
 * with a visible count so staff can triage the drift.
 */

import { overlayEffectiveStageName } from '@/lib/tax/tax-stage-overlay'

export interface BoardColumnDef {
  stage_name: string
  stage_order: number
  /** Staff-facing label (falls back to stage_name). */
  client_label: string | null
  icon: string | null
  color: string | null
  /** Days at/over which a card is "stale" (red). null = no staleness rule. */
  stale_days: number | null
}

export interface BoardCard {
  /** Service delivery id — the card's identity. */
  sdId: string
  accountId: string | null
  companyName: string | null
  entityType: string | null
  /** SD's own stage (pre-overlay). */
  sdStage: string | null
  stageEnteredAt: string | null
  reviewStatus: string | null
  /** Joined tax_returns detail (may be absent — SD with no matching return). */
  taxYear: number | null
  returnType: string | null
  deadline: string | null
  paid: boolean | null
  extensionFiled: boolean | null
  assignedTo: string | null
}

export interface BoardColumn extends BoardColumnDef {
  /** True for the synthetic catch-all column. */
  isOther: boolean
  cards: BoardCard[]
  count: number
}

export const OTHER_COLUMN_KEY = '__other__'

/**
 * Whole-day count a card has sat in its current stage. Returns null when no
 * entry timestamp is known (can't compute) — callers render "—".
 */
export function daysInStage(stageEnteredAt: string | null, now: Date): number | null {
  if (!stageEnteredAt) return null
  const entered = new Date(stageEnteredAt)
  if (Number.isNaN(entered.getTime())) return null
  const ms = now.getTime() - entered.getTime()
  if (ms < 0) return 0
  return Math.floor(ms / 86_400_000)
}

export type StalenessLevel = 'fresh' | 'warn' | 'stale'

/**
 * Traffic-light staleness for a card. With a column stale_days threshold:
 *  - >= stale_days        → 'stale' (red)
 *  - >= ceil(stale_days/2)→ 'warn'  (yellow)
 *  - else                 → 'fresh' (green)
 * No threshold (null) or unknown days → 'fresh' (never alarm without a rule).
 */
export function stalenessLevel(
  days: number | null,
  staleDays: number | null,
): StalenessLevel {
  if (days === null || staleDays === null || staleDays <= 0) return 'fresh'
  if (days >= staleDays) return 'stale'
  if (days >= Math.ceil(staleDays / 2)) return 'warn'
  return 'fresh'
}

/**
 * Group cards into board columns by effective stage. Every card lands
 * somewhere: a matching board column, or the synthetic "Other" column.
 * Columns keep catalog order; "Other" is appended last and omitted when empty.
 */
export function buildBoardColumns(
  columnDefs: BoardColumnDef[],
  cards: BoardCard[],
): BoardColumn[] {
  const ordered = [...columnDefs].sort((a, b) => a.stage_order - b.stage_order)
  const byName = new Map<string, BoardColumn>()
  const columns: BoardColumn[] = ordered.map(def => {
    const col: BoardColumn = { ...def, isOther: false, cards: [], count: 0 }
    byName.set(def.stage_name, col)
    return col
  })

  const other: BoardColumn = {
    stage_name: OTHER_COLUMN_KEY,
    stage_order: Number.MAX_SAFE_INTEGER,
    client_label: 'Other / Needs Attention',
    icon: null,
    color: null,
    stale_days: null,
    isOther: true,
    cards: [],
    count: 0,
  }

  for (const card of cards) {
    const effective = overlayEffectiveStageName(ordered, card.sdStage, card.reviewStatus)
    const target = (effective && byName.get(effective)) || other
    target.cards.push(card)
  }

  for (const col of columns) col.count = col.cards.length
  other.count = other.cards.length

  return other.count > 0 ? [...columns, other] : columns
}
