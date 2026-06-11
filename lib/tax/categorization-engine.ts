/**
 * Categorization engine — DB-backed rules (bank_categorization_rules) layered
 * over the legacy built-ins, plus the transfer-pair pass.
 *
 * Rule precedence (master plan §8 — flexible, editable without deploy):
 *   1. per-client rules (account_id = this account), by priority asc
 *   2. global rules (account_id IS NULL), by priority asc
 *   3. legacy built-in CATEGORY_RULES (bank-statement-parser.ts)
 *   4. uncategorized
 * First match wins. A rule's `direction` gates it by sign: 'in' matches only
 * inflows, 'out' only outflows, 'any' both — "Stripe" categorizes money FROM
 * Stripe as revenue without also catching refunds paid TO Stripe.
 *
 * applyRules() is pure (DI'd rules) so tests stay DB-free; the loader and the
 * account-year recategorization operation live below it.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

// bank_categorization_rules is new (migration 20260611-1400/-1700) and not yet
// in the generated database.types.ts — same untyped-client pattern as
// lib/owner-finance.ts until the next type regeneration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
import { categorizeTransaction, type CategorizedTransaction, type ParsedTransaction } from "@/lib/bank-statement-parser"
import { matchTransferPairs, type TransferCandidate } from "./transfer-matcher"

export interface CategorizationRule {
  id: string
  pattern: string
  match_type: "regex" | "contains" | "exact"
  category: CategorizedTransaction["category"]
  subcategory: string
  account_id: string | null
  priority: number
  direction: "in" | "out" | "any"
}

/** Does this rule match the transaction's text + direction? */
function ruleMatches(rule: CategorizationRule, tx: ParsedTransaction): boolean {
  if (rule.direction === "in" && tx.amount <= 0) return false
  if (rule.direction === "out" && tx.amount >= 0) return false
  const haystacks = [tx.description, tx.counterparty]
  switch (rule.match_type) {
    case "exact":
      return haystacks.some(h => h.trim().toLowerCase() === rule.pattern.trim().toLowerCase())
    case "contains":
      return haystacks.some(h => h.toLowerCase().includes(rule.pattern.toLowerCase()))
    case "regex":
      try {
        const re = new RegExp(rule.pattern, "i")
        return haystacks.some(h => re.test(h))
      } catch {
        return false // bad regex in a rule must never break ingestion
      }
  }
}

/**
 * Categorize one transaction: per-client rules → global rules → legacy
 * built-ins. Member/related-party detection from the legacy path is kept in
 * all cases (it sets is_related_party/notes independently of the category).
 */
export function applyRules(
  tx: ParsedTransaction,
  rules: CategorizationRule[],
  memberNames: string[] = [],
  relatedEntities: string[] = [],
): CategorizedTransaction {
  // Legacy result first: provides related-party flags + the built-in category fallback.
  const legacy = categorizeTransaction(tx, memberNames, relatedEntities)

  const ordered = [
    ...rules.filter(r => r.account_id !== null).sort((a, b) => a.priority - b.priority),
    ...rules.filter(r => r.account_id === null).sort((a, b) => a.priority - b.priority),
  ]
  for (const rule of ordered) {
    if (ruleMatches(rule, tx)) {
      return { ...legacy, category: rule.category, subcategory: rule.subcategory }
    }
  }
  return legacy
}

/** Load active rules for an account (its own + global). */
export async function getCategorizationRules(accountId: string): Promise<CategorizationRule[]> {
  const { data, error } = await db
    .from("bank_categorization_rules")
    .select("id, pattern, match_type, category, subcategory, account_id, priority, direction")
    .eq("active", true)
    .or(`account_id.is.null,account_id.eq.${accountId}`)
    .order("priority", { ascending: true })
  if (error) throw new Error(`Failed to load categorization rules: ${error.message}`)
  return (data ?? []) as CategorizationRule[]
}

export interface RecategorizeResult {
  scanned: number
  recategorized: number
  transferPairs: number
  uncategorizedRemaining: number
}

/**
 * Re-categorize an account's tax-year transactions: rules pass + transfer-pair
 * pass, persisting only changed rows. Run after ingest, and re-runnable any
 * time staff edit rules (idempotent).
 *
 * Guard: rows a human already corrected (notes starting "manual:") are never
 * overwritten by the engine.
 */
export async function recategorizeAccountYear(accountId: string, taxYear: number): Promise<RecategorizeResult> {
  const { data: rows, error } = await supabaseAdmin
    .from("bank_transactions")
    .select("id, transaction_date, description, counterparty, amount, currency, balance_after, transaction_ref, bank_name, account_type, category, subcategory, is_related_party, notes")
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
  if (error) throw new Error(`Failed to load transactions: ${error.message}`)
  if (!rows || rows.length === 0) return { scanned: 0, recategorized: 0, transferPairs: 0, uncategorizedRemaining: 0 }

  const rules = await getCategorizationRules(accountId)

  // member names for related-party detection (same source the tools use)
  const { data: links } = await supabaseAdmin
    .from("account_contacts")
    .select("contacts(first_name, last_name)")
    .eq("account_id", accountId)
  const memberNames = ((links ?? []) as unknown as Array<{ contacts: { first_name: string | null; last_name: string | null } | null }>)
    .filter(l => l.contacts)
    .map(l => `${l.contacts!.first_name ?? ""} ${l.contacts!.last_name ?? ""}`.trim())
    .filter(n => n.length > 0)

  // Pass 1: rules
  const updates = new Map<string, { category: string; subcategory: string; notes?: string }>()
  for (const row of rows) {
    if ((row.notes ?? "").startsWith("manual:")) continue // human corrections win, always
    const next = applyRules(row as unknown as ParsedTransaction, rules, memberNames)
    if (next.category !== row.category || next.subcategory !== (row.subcategory ?? "")) {
      updates.set(row.id as string, { category: next.category, subcategory: next.subcategory })
    }
  }

  // Pass 2: transfer pairs — computed on the post-rules categories
  const candidates: TransferCandidate[] = rows.map(r => ({
    id: r.id as string,
    transaction_date: r.transaction_date as string,
    amount: Number(r.amount),
    currency: r.currency as string,
    bank_name: r.bank_name as string,
    account_type: (r.account_type as string) ?? "",
    category: updates.get(r.id as string)?.category ?? (r.category as string),
  })).filter(c => !(rows.find(r => r.id === c.id)?.notes ?? "").startsWith("manual:"))

  const pairs = matchTransferPairs(candidates)
  for (const p of pairs) {
    updates.set(p.outflowId, { category: "conversion", subcategory: "internal_transfer", notes: `transfer-pair → ${p.inflowId}` })
    updates.set(p.inflowId, { category: "conversion", subcategory: "internal_transfer", notes: `transfer-pair → ${p.outflowId}` })
  }

  // Persist changed rows
  let recategorized = 0
  for (const [id, u] of Array.from(updates.entries())) {
    const orig = rows.find(r => r.id === id)
    if (!orig) continue
    if (orig.category === u.category && (orig.subcategory ?? "") === u.subcategory && !u.notes) continue
    const { error: upErr } = await supabaseAdmin
      .from("bank_transactions")
      .update({ category: u.category, subcategory: u.subcategory, ...(u.notes ? { notes: u.notes } : {}) })
      .eq("id", id)
    if (upErr) throw new Error(`Failed to update transaction ${id}: ${upErr.message}`)
    recategorized++
  }

  const uncategorizedRemaining = rows.filter(r => {
    const u = updates.get(r.id as string)
    return (u?.category ?? r.category) === "uncategorized"
  }).length

  return { scanned: rows.length, recategorized, transferPairs: pairs.length, uncategorizedRemaining }
}
