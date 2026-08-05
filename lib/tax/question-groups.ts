/**
 * Pattern-grouped client questions (Slice 8, master plan §3.6 + A2).
 *
 * What the deterministic + AI passes leave uncategorized is dominated by
 * merchant patterns (the 5b benchmark: Glovo ×265, Uber ×164, …). Grouping
 * by merchant root means ONE answer covers every transaction from that
 * merchant — ~10-15 clicks instead of hundreds of questions.
 *
 * The client answers in plain language; each answer maps to a bookkeeping
 * category. "Personal (owner) spending" maps to DISTRIBUTION — personal
 * spend on a company card is an owner draw, never a deductible expense.
 */

import { rowRootKey } from "./row-root"
import { suspectedMembersFromNotes } from "./member-names"

export interface UncategorizedRow {
  id: string
  description: string
  counterparty: string | null
  amount: number
  transaction_date: string
  bank_name: string
  /** Statement currency — part of the group key so a card never sums EUR+USD
   *  into one meaningless total (matches buildGroupedAiCandidates keying). */
  currency?: string | null
  /** Advisory AI hints (#2) — present once the AI labeling pass has run. */
  ai_lean?: string | null
  ai_bucket?: string | null
  /** Current subcategory — lets the UI light the precise chip (owner draw vs
   *  personal spend both live in 'distribution'; 2026-07-07). */
  subcategory?: string | null
  /** The row's current bookkeeping category (no-vanish: lets the review show
   *  the owner's current choice instead of dropping decided rows). */
  category?: string | null
  /** The row's note. Read ONLY to recover the suspected-member mark — the note
   *  itself is internal provenance and is never shown to a client. */
  notes?: string | null
}

export interface QuestionGroup {
  /** Stable key — merchant root + direction + currency (GROUP_KEY_SEP-joined).
   *  Per-direction since 2026-07-05: a mixed merchant (PayPal deposits AND
   *  withdrawals) renders as TWO cards, each with direction-pure answer chips —
   *  "Business expense" can never appear on a money-in card again. */
  group_key: string
  /** Display label (the merchant root as seen on the statement). */
  label: string
  count: number
  total: number
  /** Statement currency of every row in this group ('' when unknown). */
  currency: string
  /** 'in' | 'out' — drives which answers make sense. Never 'mixed': mixed
   *  merchants are split into one group per direction. */
  direction: "in" | "out"
  transaction_ids: string[]
  sample: string
  /** Advisory AI hints for this merchant (#2): the dominant lean + bucket across
   *  the group's rows. Used to pre-tag + group the review; the client confirms. */
  ai_lean?: "business" | "personal" | "unsure"
  ai_bucket?: string
  /** The group's current bookkeeping category (mode across its rows) — drives
   *  which answer chip shows as selected so a flagged row never just vanishes. */
  current_category?: string
  /** Mode subcategory — distinguishes owner draws from personal spend inside
   *  'distribution' so the selected chip is honest (2026-07-07). */
  current_subcategory?: string
  /**
   * Members this group's payments MIGHT have gone to — the payee carries their
   * surname but not their full name. Drives promotion into "Needs your
   * decision" and the line naming them on the card.
   *
   * A DISTINCT LIST, never a mode. `mode` skips empty values, so one marked row
   * among nine unmarked ones would have won outright and the card would have
   * claimed all ten payments were to that owner — a false statement to a client
   * about their own company. The count below says how many actually match.
   */
  suspected_members?: string[]
  /** How many rows in this group carry a mark (≤ count). */
  suspected_count?: number
  /**
   * The ids of ONLY the marked rows. The owner question answers these and
   * nothing else — a group can mix marked and unmarked payments (the payee
   * often lives in the counterparty while the group's name comes from the
   * description), and booking all of them as owner draws on a "yes" turns real
   * supplier payments into withdrawals on a partner's K-1.
   */
  suspected_ids?: string[]
}

/** Most-frequent non-empty value in a list (ties → first seen). */
function mode(values: Array<string | null | undefined>): string | undefined {
  const counts = new Map<string, number>()
  for (const v of values) {
    if (!v) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let best: string | undefined
  let bestN = 0
  for (const [v, n] of Array.from(counts.entries())) if (n > bestN) { best = v; bestN = n }
  return best
}

/** Merchant root: strip card suffixes (••1234), embedded dates, amounts, and
 *  collapse whitespace. Exported for tests. */
export function merchantRoot(description: string): string {
  return description
    .replace(/\s*••\d+/g, "")
    .replace(/\b\d{2}\/\d{2}\b/g, "")
    .replace(/\b\d{4,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim()
}

/** Separator inside group_key. ASCII unit separator — bank descriptions can
 *  legitimately contain '#' / '|' / '::', but never this control character,
 *  so splitting on it can't truncate a merchant root. */
export const GROUP_KEY_SEP = "\u001f"

/** The merchant-root component of a (possibly composite) group key. The
 *  period one-by-one filter compares on roots (presence-periods emits bare
 *  rowRootKey keys), so it must strip the direction/currency suffix. */
export function groupKeyRoot(groupKey: string): string {
  return groupKey.split(GROUP_KEY_SEP)[0]
}

/** Row direction for grouping. Explicit zero rule: only strictly-negative
 *  amounts are money out; 0-amount rows (normally auto-booked as
 *  conversion/zero_amount before ever reaching the review) count as 'in'. */
export function rowDirection(amount: number): "in" | "out" {
  return amount < 0 ? "out" : "in"
}

export function groupUncategorized(rows: UncategorizedRow[]): QuestionGroup[] {
  // Phase 3R (cond. 11-12): grouping goes through the SHARED rowRootKey —
  // description-first with degenerate-description fallback to counterparty
  // ("Unknown - Corporate Card - 6921" groups as its counterparty "Bershka").
  // Split per (root, direction, currency) — same keying as the grouped AI
  // candidates — so answer chips are direction-pure and totals single-currency.
  const groups = new Map<string, { rows: UncategorizedRow[]; label: string; direction: "in" | "out"; currency: string; degenerate: boolean }>()
  for (const r of rows) {
    // `degenerate` marks a CATCH-ALL bucket ("(no description)", bare
    // "card"/"spend") holding rows with nothing in common. It is captured so
    // the card can SAY so — not to hide the owner question, which is what an
    // earlier cut did and which meant a flagged payment in one of these buckets
    // was flagged in the data, withheld from the AI, and asked of NOBODY.
    // 1,271 outgoing payments on production have a description this weak.
    const { key, label, degenerate } = rowRootKey(r.description, r.counterparty)
    const direction = rowDirection(r.amount)
    const currency = (r.currency ?? "").toUpperCase()
    const groupKey = key + GROUP_KEY_SEP + direction + GROUP_KEY_SEP + currency
    if (!groups.has(groupKey)) groups.set(groupKey, { rows: [], label, direction, currency, degenerate: !!degenerate })
    groups.get(groupKey)!.rows.push(r)
  }
  return Array.from(groups.entries())
    .map(([group_key, g]) => {
      const leanRaw = mode(g.rows.map(r => r.ai_lean))
      const lean: QuestionGroup["ai_lean"] | undefined =
        leanRaw === "business" || leanRaw === "personal" || leanRaw === "unsure" ? leanRaw : undefined
      const bucket = mode(g.rows.map(r => r.ai_bucket))
      const current_category = mode(g.rows.map(r => r.category))
      const current_subcategory = mode(g.rows.map(r => r.subcategory))
      // Distinct suspected members + how many rows actually carry a mark.
      // Never moded (see the field's doc): one marked row must not speak for
      // the whole group.
      //
      // NOT suppressed on a catch-all root any more. That suppression was a
      // guard for a problem since solved properly: the card states how many of
      // the group's payments actually match ("1 of these 40 …") and the answer
      // targets only those ids, so naming the owner can no longer overclaim.
      // Keeping it would have been the worse trade — a question raised and
      // shown to nobody.
      const markedRows = g.rows.filter(r => suspectedMembersFromNotes(r.notes).length > 0)
      const suspected_members = Array.from(new Set(markedRows.flatMap(r => suspectedMembersFromNotes(r.notes)))).sort()
      const suspected_count = markedRows.length
      const suspected_ids = markedRows.map(r => r.id)
      return {
        group_key,
        label: g.label,
        count: g.rows.length,
        total: g.rows.reduce((s, r) => s + r.amount, 0),
        currency: g.currency,
        direction: g.direction,
        transaction_ids: g.rows.map(r => r.id),
        sample: g.rows[0].description,
        ...(lean ? { ai_lean: lean } : {}),
        ...(bucket ? { ai_bucket: bucket } : {}),
        ...(current_category ? { current_category } : {}),
        ...(current_subcategory ? { current_subcategory } : {}),
        ...(suspected_members.length ? { suspected_members, suspected_count, suspected_ids } : {}),
      }
    })
    .sort((a, b) => b.count - a.count)
}

/** The client-facing answer choices and the category each maps to.
 *  Filtered by the group's money direction in the UI. */
export const ANSWER_CHOICES = [
  // Direction-pure since 2026-07-05 (groups are split per direction, 'mixed'
  // no longer exists): a money-in card can never offer "Business expense".
  { value: "business_expense", category: "expense", subcategory: "client_confirmed", directions: ["out"], label: "Business expense", labelIt: "Spesa aziendale" },
  { value: "personal_spending", category: "distribution", subcategory: "personal_draw", directions: ["out"], label: "Personal (owner) spending — not a business cost", labelIt: "Spesa personale (del socio) — non aziendale" },
  // Explicit owner-draw answer (2026-07-07, Antonio — Dynamiq: wires to a
  // member offered no dividend option). Same P&L/M-2 treatment as any
  // distribution (equity out, attributed to the member by name); the plain
  // "dividend" label is the point.
  { value: "owner_draw", category: "distribution", subcategory: "member_distribution", directions: ["out"], label: "Owner draw / dividend (money to a member)", labelIt: "Prelievo del socio / dividendo" },
  { value: "business_income", category: "income", subcategory: "revenue", directions: ["in"], label: "Business income / a sale", labelIt: "Incasso aziendale / vendita" },
  { value: "owner_money_in", category: "contribution", subcategory: "capital_contribution", directions: ["in"], label: "My own money put into the company", labelIt: "Soldi miei messi nella società" },
  // Refund books signed contra-expense (pnl-generator nets it against costs) —
  // the right answer for money back from a merchant you buy from; tapping
  // "Business income" there would inflate revenue. Both directions: an
  // out-refund is you returning money to a customer.
  { value: "refund", category: "refund", subcategory: "client_confirmed", directions: ["in", "out"], label: "Refund / money back", labelIt: "Rimborso / soldi restituiti" },
  { value: "own_transfer", category: "conversion", subcategory: "internal_transfer", directions: ["in", "out"], label: "Transfer between my own accounts", labelIt: "Trasferimento tra i miei conti" },
  { value: "bank_fee", category: "fee", subcategory: "bank_fee", directions: ["out"], label: "Bank / platform fee", labelIt: "Commissione bancaria / piattaforma" },
] as const

export type AnswerValue = (typeof ANSWER_CHOICES)[number]["value"]

export function categoryForAnswer(value: string): { category: string; subcategory: string } | null {
  const c = ANSWER_CHOICES.find(a => a.value === value)
  return c ? { category: c.category, subcategory: c.subcategory } : null
}
