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

import { rowRootKey, RAIL_SET } from "@/lib/tax/row-root"

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

/** Generic banking words that must NEVER become a contains-rule (Phase 4,
 *  2026-07-02): a root like "payment" or "transfer" would blanket-match half
 *  the statement. Exact normalized-root match, EN + IT vocabulary. */
export const LEARN_PATTERN_STOPLIST = new Set([
  "payment", "payments", "transfer", "transfers", "wire", "fee", "fees",
  "card", "pos", "ach", "deposit", "withdrawal", "credit", "debit", "check",
  "invoice", "transaction", "balance",
  // Italian equivalents (Wise IT descriptions)
  "pagamento", "pagamenti", "bonifico", "bonifici", "commissione", "commissioni",
  "versamento", "prelievo", "fattura", "addebito", "accredito",
])

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
    // Phase 3R (cond. 12-13): SAME root the review grouped by — and NEVER
    // learn from a counterparty-fallback root. A fallback root means the
    // description was degenerate ("Unknown - Corporate Card…"); learning a
    // contains-rule from either side of that pair would blanket-match every
    // corporate-card row (or an MCC label like "Restaurants") on future runs.
    const { label, source, degenerate } = rowRootKey(r.description, r.counterparty)
    if (source !== "description" || degenerate) continue
    const key = label.trim()
    if (key.length < MIN_LEARN_PATTERN_LENGTH) continue // skip blank/generic
    if (key.toLowerCase() === "(no description)") continue
    if (LEARN_PATTERN_STOPLIST.has(key.toLowerCase())) continue // generic banking word — never a contains-rule
    if (RAIL_SET.has(key.toLowerCase())) continue // payment rail — a contains-rule would book every carried merchant
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

/** Where a learned rule lives (Phase 4, 2026-07-02): a real client's account
 *  (permanent, year-after-year memory) OR a blank workspace (scratch memory
 *  that cascades away with the workspace and is PROMOTED to the client on
 *  Save-to-client). Mutually exclusive — enforced by the DB CHECK. */
export type LearnScope = { account_id: string; workspace_id?: undefined } | { workspace_id: string; account_id?: undefined }

/** Minimal DB surface this helper needs — lets tests inject a fake. */
export interface RuleStore {
  findRule(scope: LearnScope, pattern: string, direction: string): Promise<{ id: string } | null>
  insertRule(row: Record<string, unknown>): Promise<void>
  updateRule(id: string, patch: Record<string, unknown>): Promise<void>
  /** Phase 0.2 (2026-07-03): active rules for the same (scope, pattern) whose
   *  direction OVERLAPS keepDirection — i.e. 'any' conflicts with 'in'/'out'
   *  and vice versa; 'in' and 'out' are COMPATIBLE (direction gating separates
   *  them: PayPal can be income inbound and vendor-payment outbound). The
   *  upsert deactivates conflicts so two overlapping rules can never coexist
   *  with a nondeterministic winner. */
  findConflicting(scope: LearnScope, pattern: string, keepDirection: string): Promise<Array<{ id: string }>>
}

/**
 * Build a RuleStore backed by a Supabase client. The `db` param is loosely
 * typed on purpose: chaining the fully-typed supabase-js builder inline in an
 * API route triggers TS "type instantiation is excessively deep". Erasing the
 * generic here keeps the route compiling while the table/columns stay correct.
 */
export function makeSupabaseRuleStore(db: { from: (table: string) => any }): RuleStore { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    findRule: async (scope, pattern, direction) => {
      let q = db
        .from("bank_categorization_rules")
        .select("id")
        .eq("pattern", pattern)
        .eq("direction", direction)
      q = scope.account_id
        ? q.eq("account_id", scope.account_id).is("workspace_id", null)
        : q.eq("workspace_id", scope.workspace_id)
      const { data } = await q.limit(1).maybeSingle()
      return data ? { id: data.id as string } : null
    },
    insertRule: async (row) => {
      await db.from("bank_categorization_rules").insert(row)
    },
    updateRule: async (id, patch) => {
      await db.from("bank_categorization_rules").update(patch).eq("id", id)
    },
    findConflicting: async (scope, pattern, keepDirection) => {
      // 'any' overlaps 'in'+'out'; 'in'/'out' overlap only 'any'.
      const conflictDirs = keepDirection === "any" ? ["in", "out"] : ["any"]
      let q = db
        .from("bank_categorization_rules")
        .select("id")
        .eq("pattern", pattern)
        .eq("active", true)
        .in("direction", conflictDirs)
      q = scope.account_id
        ? q.eq("account_id", scope.account_id).is("workspace_id", null)
        : q.eq("workspace_id", scope.workspace_id)
      const { data } = await q
      return (data ?? []) as Array<{ id: string }>
    },
  }
}

/**
 * Persist the learned rules for a scope, upserting on
 * (scope, pattern, direction). `scope` accepts a bare account id string for
 * backward compatibility with the portal answer route. Returns how many rules
 * were created vs updated. Single-rule failure mid-batch is the caller's
 * concern; this resolves the batch and lets the caller log.
 */
export async function upsertLearnedMerchantRules(
  store: RuleStore,
  scopeInput: LearnScope | string,
  rows: LearnableRow[],
  category: string,
  subcategory: string,
  createdBy: string,
): Promise<{ created: number; updated: number }> {
  const scope: LearnScope = typeof scopeInput === "string" ? { account_id: scopeInput } : scopeInput
  const specs = deriveLearnedRules(rows, category, subcategory)
  let created = 0
  let updated = 0
  for (const spec of specs) {
    // Direction reconciliation (Phase 0.2): an 'any' rule supersedes 'in'/'out'
    // for the same pattern (and vice versa when the owner's newest answer is
    // direction-specific) — deactivate the conflicting variants so applyRules
    // never has two contradictory candidates at equal priority.
    const conflicting = await store.findConflicting(scope, spec.pattern, spec.direction)
    for (const c of conflicting) {
      await store.updateRule(c.id, {
        active: false,
        notes: "deactivated: superseded by a newer answer with a different direction",
        updated_at: new Date().toISOString(),
      })
    }
    const existing = await store.findRule(scope, spec.pattern, spec.direction)
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
        account_id: scope.account_id ?? null,
        workspace_id: scope.workspace_id ?? null,
        direction: spec.direction,
        priority: 100,
        active: true,
        source: "learned",
        notes: scope.workspace_id
          ? "learned from staff answer in a P&L workspace"
          : "learned from an answer on the tax-financials review",
        created_by: createdBy,
      })
      created += 1
    }
  }
  return { created, updated }
}
