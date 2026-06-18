/**
 * Per-client learned categorization rules (2026-06-18).
 *
 * When a client answers/flags a merchant group on the tax-financials review
 * screen, we ALSO persist a per-client rule into `bank_categorization_rules`
 * (account_id = this account, source = 'learned'). The categorization engine
 * already applies a client's own rules BEFORE the global rules
 * (`applyRules` in categorization-engine.ts), so next year — and any re-run —
 * that merchant auto-categorizes the way the owner declared it, instead of
 * landing in the question list again.
 *
 * Design notes:
 * - The pattern is the merchant ROOT (same normalization the question grouper
 *   uses), matched 'contains' against description/counterparty — exactly what
 *   `ruleMatches` checks. Direction (in/out/any) is derived from the answered
 *   rows so an inflow rule never catches an outflow of the same name.
 * - Blank or too-short roots are skipped (a 1-2 char 'contains' rule would
 *   over-match everything). Per-client scope already bounds the blast radius.
 * - Upsert by (account_id, pattern, direction): if the owner later flips the
 *   same merchant (business → personal), the existing rule is UPDATED, not
 *   duplicated.
 */

import { merchantRoot } from "@/lib/tax/question-groups"

export interface LearnableRow {
  description: string | null
  counterparty: string | null
  amount: number | string
}

export interface LearnedRuleSpec {
  pattern: string
  match_type: "contains"
  category: string
  subcategory: string
  direction: "in" | "out" | "any"
}

/** Minimum merchant-root length to learn — shorter is too generic for a
 *  'contains' match and would risk catching unrelated transactions. */
export const MIN_LEARN_PATTERN_LENGTH = 3

/**
 * PURE: derive the per-client rule(s) to learn from a set of answered rows and
 * the category they were assigned. Groups the rows by merchant root (normally
 * one root per answered group, but robust to more), computes each root's money
 * direction, and drops roots that are blank or too short. Exported for tests.
 */
export function deriveLearnedRules(
  rows: LearnableRow[],
  category: string,
  subcategory: string,
): LearnedRuleSpec[] {
  const byRoot = new Map<string, { ins: number; outs: number }>()
  for (const r of rows) {
    const root = merchantRoot(r.description || r.counterparty || "")
    const key = root.trim()
    if (key.length < MIN_LEARN_PATTERN_LENGTH) continue // skip blank/generic
    if (key.toLowerCase() === "(no description)") continue
    if (!byRoot.has(key)) byRoot.set(key, { ins: 0, outs: 0 })
    const amt = Number(r.amount)
    if (amt > 0) byRoot.get(key)!.ins += 1
    else if (amt < 0) byRoot.get(key)!.outs += 1
  }
  return Array.from(byRoot.entries()).map(([pattern, c]) => ({
    pattern,
    match_type: "contains" as const,
    category,
    subcategory,
    direction: (c.ins > 0 && c.outs > 0 ? "any" : c.ins > 0 ? "in" : "out") as LearnedRuleSpec["direction"],
  }))
}

/** Minimal DB surface this helper needs — lets tests inject a fake. */
export interface RuleStore {
  findRule(accountId: string, pattern: string, direction: string): Promise<{ id: string } | null>
  insertRule(row: Record<string, unknown>): Promise<void>
  updateRule(id: string, patch: Record<string, unknown>): Promise<void>
}

/**
 * Build a RuleStore backed by a Supabase client. The `db` param is loosely
 * typed on purpose: chaining the fully-typed supabase-js builder inline in an
 * API route triggers TS "type instantiation is excessively deep". Erasing the
 * generic here keeps the route compiling while the table/columns stay correct.
 */
export function makeSupabaseRuleStore(db: { from: (table: string) => any }): RuleStore { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    findRule: async (accountId, pattern, direction) => {
      const { data } = await db
        .from("bank_categorization_rules")
        .select("id")
        .eq("account_id", accountId)
        .eq("pattern", pattern)
        .eq("direction", direction)
        .limit(1)
        .maybeSingle()
      return data ? { id: data.id as string } : null
    },
    insertRule: async (row) => {
      await db.from("bank_categorization_rules").insert(row)
    },
    updateRule: async (id, patch) => {
      await db.from("bank_categorization_rules").update(patch).eq("id", id)
    },
  }
}

/**
 * Persist the learned rules for an account, upserting on
 * (account_id, pattern, direction). Returns how many rules were created vs
 * updated. Never throws on a single-rule failure mid-batch is the caller's
 * concern; this resolves the batch and lets the caller log.
 */
export async function upsertLearnedMerchantRules(
  store: RuleStore,
  accountId: string,
  rows: LearnableRow[],
  category: string,
  subcategory: string,
  createdBy: string,
): Promise<{ created: number; updated: number }> {
  const specs = deriveLearnedRules(rows, category, subcategory)
  let created = 0
  let updated = 0
  for (const spec of specs) {
    const existing = await store.findRule(accountId, spec.pattern, spec.direction)
    if (existing) {
      await store.updateRule(existing.id, {
        category: spec.category,
        subcategory: spec.subcategory,
        active: true,
        source: "learned",
        updated_at: new Date().toISOString(),
      })
      updated += 1
    } else {
      await store.insertRule({
        pattern: spec.pattern,
        match_type: spec.match_type,
        category: spec.category,
        subcategory: spec.subcategory,
        account_id: accountId,
        direction: spec.direction,
        priority: 100,
        active: true,
        source: "learned",
        notes: "learned from client answer on the tax-financials review",
        created_by: createdBy,
      })
      created += 1
    }
  }
  return { created, updated }
}
