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

/** Assignee options for the Tax Board (free-text staff names in the DB today). */
export const TAX_BOARD_ASSIGNEES = ['Luca', 'Antonio'] as const
export type TaxBoardAssignee = (typeof TAX_BOARD_ASSIGNEES)[number]

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

// ─── Drag-to-advance legality (Slice 7b) ──────────────────────────────
//
// The board has two kinds of columns. REAL SD-stage columns are advanced by
// dragging (→ advanceServiceDelivery, silent). The five REVIEW sub-state
// columns (Data Submitted / Under Review / Revision Requested / Approved /
// Confirmed) are NOT drag targets — they're driven by the review state machine
// (lib/tax/review-status.ts) through the Slice-4 What's New action buttons,
// which enforce legality, require a note for "request changes", and reserve
// client-only transitions (Confirmed). Letting drag bypass that would corrupt
// review state, so 7b deliberately keeps the two paths separate:
//   • a card IN the review loop (reviewStatus != null) is NOT draggable
//   • a review sub-state column (or "Other") is NOT a drop target
// This is a correctness boundary, not a shortcut — see docs/systems/tax-returns.md.

import { REVIEW_STATUS_STAGE } from '@/lib/tax/tax-stage-overlay'

/** The catalog stage_names that represent review sub-states (overlay targets). */
export const REVIEW_SUBSTATE_STAGE_NAMES: ReadonlySet<string> = new Set(
  Object.values(REVIEW_STATUS_STAGE),
)

export function isReviewSubstateColumn(stageName: string): boolean {
  return REVIEW_SUBSTATE_STAGE_NAMES.has(stageName)
}

/**
 * A column accepts drops (and its cards are draggable) only when it is a REAL
 * SD stage — not a review sub-state, not the synthetic "Other". Draggability is
 * keyed off the column a card CURRENTLY sits in (its effective stage), NOT raw
 * review_status: a card past review (client confirmed → SD at "Data Received")
 * carries review_status='confirmed' yet sits in a real stage and must stay
 * draggable.
 */
export function isDroppableColumn(col: Pick<BoardColumn, 'stage_name' | 'isOther'>): boolean {
  return !col.isOther && !isReviewSubstateColumn(col.stage_name)
}

export interface ColumnRef {
  stage_name: string
  isOther: boolean
}

export interface DropDecision {
  ok: boolean
  /** Reason a drop is rejected (for a toast); undefined when ok. */
  reason?: string
}

/**
 * Decide whether dragging a card from `source` column onto `target` column is
 * allowed. Both must be real SD-stage columns and differ. Pure — the server
 * action re-checks independently from the DB (never trust the drag).
 */
export function resolveDrop(source: ColumnRef, target: ColumnRef): DropDecision {
  if (target.isOther) {
    return { ok: false, reason: '“Other / Needs Attention” is not a stage — fix the underlying SD stage instead.' }
  }
  if (isReviewSubstateColumn(target.stage_name)) {
    return { ok: false, reason: 'Use the review actions on the What’s New card to move through review.' }
  }
  if (!isDroppableColumn(source)) {
    return source.isOther
      ? { ok: false, reason: 'This card is off-pipeline — fix its SD stage first.' }
      : { ok: false, reason: 'This return is in the review loop — use the What’s New review actions.' }
  }
  if (source.stage_name === target.stage_name) {
    return { ok: false, reason: 'Already in this stage.' }
  }
  return { ok: true }
}

// ─── Bulk advance (Slice 7c) ──────────────────────────────────────────
//
// Bulk advance applies the SAME per-card legality as a single drag
// (resolveDrop). A mixed selection (cards in different stages, or some not
// eligible) is partitioned into eligible vs skipped so the confirm dialog can
// show exactly what will and won't move — no silent partial application.

export interface BulkAdvanceItem {
  sdId: string
  source: ColumnRef
}

export interface BulkAdvanceSummary {
  /** sdIds that will advance to the target. */
  eligible: string[]
  /** sdIds that won't, each with the reason. */
  skipped: { sdId: string; reason: string }[]
}

export function summarizeBulkAdvance(
  items: BulkAdvanceItem[],
  target: ColumnRef,
): BulkAdvanceSummary {
  const eligible: string[] = []
  const skipped: { sdId: string; reason: string }[] = []
  for (const item of items) {
    const d = resolveDrop(item.source, target)
    if (d.ok) eligible.push(item.sdId)
    else skipped.push({ sdId: item.sdId, reason: d.reason ?? 'Not allowed' })
  }
  return { eligible, skipped }
}

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
