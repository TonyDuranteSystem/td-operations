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
import { fetchAllBankTransactionsByYear } from "@/lib/bank-transactions-fetch"

// bank_categorization_rules is new (migration 20260611-1400/-1700) and not yet
// in the generated database.types.ts — same untyped-client pattern as
// lib/owner-finance.ts until the next type regeneration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
import { categorizeTransaction, type CategorizedTransaction, type ParsedTransaction } from "@/lib/bank-statement-parser"
import { matchTransferPairs, detectOwnEntityTransfers, type TransferCandidate } from "./transfer-matcher"
import { aiSuggestCategories, type AiCategorizableTx, type AiCategorizeOptions } from "./ai-categorizer"
import { getExpenseBuckets } from "./expense-buckets"

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
  aiCategorized: number
  aiErrors: string[]
  uncategorizedRemaining: number
}

export interface RecategorizeOptions {
  /** Run the AI-assist pass (Slice 5b) on whatever the deterministic passes
   *  left uncategorized. Only HIGH-confidence suggestions are applied, tagged
   *  "ai:high" in notes. Off by default (costs API calls). */
  aiAssist?: boolean
  aiOptions?: AiCategorizeOptions
}

/** The bank_transactions columns this engine reads (matches the select below).
 *  Exported so the standalone P&L workspace path reuses the exact row shape. */
export interface CategorizableRow {
  id: string
  transaction_date: string
  description: string | null
  counterparty: string | null
  amount: number | string
  currency: string | null
  balance_after: number | null
  transaction_ref: string | null
  bank_name: string | null
  account_type: string | null
  category: string
  subcategory: string | null
  is_related_party: boolean | null
  notes: string | null
  ai_lean: string | null
  ai_bucket: string | null
}

/** A pending change to one transaction produced by the deterministic passes. */
export type RecatUpdate = { category?: string; subcategory?: string; notes?: string; ai_lean?: string; ai_bucket?: string }

/**
 * PURE deterministic core of {@link recategorizeAccountYear}: pass 1 (rules),
 * pass 2 (transfer pairs), pass 2b (own-entity self-transfers). Builds the
 * per-row update map from IN-MEMORY inputs only — no DB, no AI, no network.
 *
 * Extracted (2026-07-01, standalone P&L workspace tool) so the workspace path
 * and the client account path share ONE categorization algorithm and can never
 * diverge — the parity guarantee. `recategorizeAccountYear` delegates to this,
 * then layers its optional AI-assist pass + DB persistence on top. Do NOT add
 * any I/O here.
 */
export function computeRecategorizationUpdates(
  rows: CategorizableRow[],
  rules: CategorizationRule[],
  memberNames: string[],
  companyName: string,
): { updates: Map<string, RecatUpdate>; transferPairs: number } {
  // Pass 1: rules. (ai_lean/ai_bucket are ADVISORY review hints — #2 — written
  // for residual rows even when their category stays uncategorized.)
  const updates = new Map<string, RecatUpdate>()
  for (const row of rows) {
    if ((row.notes ?? "").startsWith("manual:")) continue // human corrections win, always
    const isAiTagged = (row.notes ?? "").startsWith("ai:")
    const next = applyRules(row as unknown as ParsedTransaction, rules, memberNames)
    // A re-run must never downgrade an AI-categorized row back to uncategorized
    // just because no deterministic rule covers it.
    if (isAiTagged && next.category === "uncategorized") continue
    if (next.category !== row.category || next.subcategory !== (row.subcategory ?? "")) {
      // When a rule overrides an AI suggestion, the "ai:" tag no longer applies.
      updates.set(row.id as string, { category: next.category, subcategory: next.subcategory, ...(isAiTagged ? { notes: "" } : {}) })
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

  // Pass 2b: own-entity self-transfers — money to/from the company's OWN name is
  // an internal transfer even with no matching leg (Wise-fee / single-leg moves
  // that pure pair-matching can't catch). Runs on post-rules categories, before
  // the AI pass, so these never reach the AI to be guessed as expense. Member
  // distributions are already booked by the rules pass and are excluded from the
  // matchable set, preserving member-name precedence. dev_task 3639451c.
  const ownHits = detectOwnEntityTransfers(
    rows
      .filter(r => !(r.notes ?? "").startsWith("manual:"))
      .map(r => ({
        id: r.id as string,
        description: r.description as string | null,
        counterparty: r.counterparty as string | null,
        category: updates.get(r.id as string)?.category ?? (r.category as string),
      })),
    { ownNames: [companyName].filter(Boolean) },
  )
  for (const id of ownHits) {
    updates.set(id, { category: "conversion", subcategory: "internal_transfer", notes: "own-entity transfer" })
  }

  return { updates, transferPairs: pairs.length }
}

/**
 * Re-categorize an account's tax-year transactions: rules pass + transfer-pair
 * pass (+ optional AI-assist pass), persisting only changed rows. Run after
 * ingest, and re-runnable any time staff edit rules (idempotent).
 *
 * Precedence: manual ("manual:" notes) > rules > AI. Guards:
 * - rows a human corrected are never overwritten by ANY pass
 * - rules may recategorize an AI-tagged row (rule wins, "ai:" tag cleared),
 *   but a re-run never downgrades an AI-categorized row back to uncategorized
 */
export async function recategorizeAccountYear(
  accountId: string,
  taxYear: number,
  opts?: RecategorizeOptions,
): Promise<RecategorizeResult> {
  // Paginated read — a >1000-tx account otherwise had only the first 1000 rows
  // recategorized, leaving the rest uncategorized and breaking transfer-pair
  // matching across the full year.
  const rows = await fetchAllBankTransactionsByYear<CategorizableRow>(
    accountId,
    taxYear,
    "id, transaction_date, description, counterparty, amount, currency, balance_after, transaction_ref, bank_name, account_type, category, subcategory, is_related_party, notes, ai_lean, ai_bucket",
  )
  if (rows.length === 0) return { scanned: 0, recategorized: 0, transferPairs: 0, aiCategorized: 0, aiErrors: [], uncategorizedRemaining: 0 }

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

  // Company's own legal name — used by the own-entity self-transfer pass below
  // and (when aiAssist) reused for the AI context. Fetched once, unconditionally.
  const { data: acctRow } = await supabaseAdmin
    .from("accounts")
    .select("company_name")
    .eq("id", accountId)
    .single()
  const companyName = acctRow?.company_name ?? ""

  // Passes 1 (rules) + 2 (transfer pairs) + 2b (own-entity self-transfers): the
  // pure deterministic core, extracted so the standalone P&L workspace tool
  // categorizes IDENTICALLY to this client path (no divergence — parity
  // guarantee). See computeRecategorizationUpdates above.
  const { updates, transferPairs } = computeRecategorizationUpdates(rows, rules, memberNames, companyName)

  // Pass 3 (optional, Slice 5b): AI assist on what's STILL uncategorized after
  // the deterministic passes. Only high-confidence suggestions are applied,
  // tagged "ai:high" so staff and the review screen can always tell them apart.
  let aiCategorized = 0
  let aiErrors: string[] = []
  if (opts?.aiAssist) {
    // Option B (#2): label the FULL reviewable set for advisory hints — outflows
    // booked as a business cost (expense/fee/cogs) or still undecided, and
    // inflows booked as income or undecided — so the client review is pre-sorted
    // even for rows a rule already expensed. Skip rows that already have both
    // hints (idempotent + cost). Category is still APPLIED only to uncategorized
    // rows below (a rule/AI never auto-decides personal — that's the owner's call).
    const catById = new Map(rows.map(r => [r.id as string, r.category as string]))
    const toLabel = rows.filter(r => {
      if ((r.notes ?? "").startsWith("manual:")) return false
      if ((r.ai_lean ?? null) !== null && (r.ai_bucket ?? null) !== null) return false
      const cat = updates.get(r.id as string)?.category ?? (r.category as string)
      const amt = Number(r.amount)
      return amt < 0
        ? ["uncategorized", "expense", "fee", "cogs"].includes(cat)
        : ["uncategorized", "income"].includes(cat)
    })
    if (toLabel.length > 0) {
      // The client's own business-activity description (tax form) — lets the
      // AI mark business tools high-confidence instead of hedging. Note:
      // completed_at can be NULL on completed rows; select by status.
      const { data: sub } = await supabaseAdmin
        .from("tax_return_submissions")
        .select("submitted_data")
        .eq("account_id", accountId)
        .eq("tax_year", taxYear)
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      const businessDescription =
        (sub?.submitted_data as Record<string, unknown> | null)?.["us_business_activities"] as string | undefined
      const bankNames = Array.from(new Set(rows.map(r => (r.bank_name as string) ?? "").filter(Boolean)))
      const txs: AiCategorizableTx[] = toLabel.map(r => ({
        id: r.id as string,
        transaction_date: r.transaction_date as string,
        description: (r.description as string) ?? "",
        counterparty: (r.counterparty as string) ?? "",
        amount: Number(r.amount),
        currency: (r.currency as string) ?? "USD",
        bank_name: (r.bank_name as string) ?? "",
      }))
      const buckets = await getExpenseBuckets(db)
      const ai = await aiSuggestCategories(
        txs,
        { companyName: companyName || "the company", memberNames, bankNames, businessDescription, buckets },
        opts.aiOptions,
      )
      aiErrors = ai.errors
      for (const s of ai.suggestions) {
        // ADVISORY review hints (#2): recorded for EVERY suggestion (any
        // confidence) so the client review can pre-sort by bucket + pre-tag the
        // business/personal lean. They NEVER change the bookkeeping category.
        const hint: { ai_lean?: string; ai_bucket?: string } = {}
        if (s.lean) hint.ai_lean = s.lean
        if (s.bucket) hint.ai_bucket = s.bucket
        // Category is APPLIED only when the row is still uncategorized — a rule or
        // the AI must never re-categorize a row the deterministic pass already
        // booked (and never auto-decide personal: that's the owner's call). For
        // already-booked rows we record the advisory hints only.
        const effCat = updates.get(s.id)?.category ?? catById.get(s.id)
        if (s.confidence === "high" && effCat === "uncategorized") {
          updates.set(s.id, { ...updates.get(s.id), category: s.category, subcategory: s.subcategory, notes: "ai:high", ...hint })
          aiCategorized++
        } else if (hint.ai_lean || hint.ai_bucket) {
          updates.set(s.id, { ...updates.get(s.id), ...hint })
        }
      }
    }
  }

  // Persist changed rows
  let recategorized = 0
  for (const [id, u] of Array.from(updates.entries())) {
    const orig = rows.find(r => r.id === id)
    if (!orig) continue
    // A hint-only update (non-high AI) leaves category/subcategory as-is.
    const nextCategory = u.category ?? (orig.category as string)
    const nextSub = u.subcategory ?? ((orig.subcategory as string) ?? "")
    const catChanged = nextCategory !== orig.category || nextSub !== ((orig.subcategory as string) ?? "")
    const leanChanged = u.ai_lean !== undefined && u.ai_lean !== ((orig.ai_lean as string | null) ?? undefined)
    const bucketChanged = u.ai_bucket !== undefined && u.ai_bucket !== ((orig.ai_bucket as string | null) ?? undefined)
    if (!catChanged && !u.notes && !leanChanged && !bucketChanged) continue
    const payload: Record<string, unknown> = { category: nextCategory, subcategory: nextSub }
    if (u.notes) payload.notes = u.notes
    if (u.ai_lean !== undefined) payload.ai_lean = u.ai_lean
    if (u.ai_bucket !== undefined) payload.ai_bucket = u.ai_bucket
    const { error: upErr } = await supabaseAdmin
      .from("bank_transactions")
      .update(payload)
      .eq("id", id)
    if (upErr) throw new Error(`Failed to update transaction ${id}: ${upErr.message}`)
    recategorized++
  }

  const uncategorizedRemaining = rows.filter(r => {
    const u = updates.get(r.id as string)
    return (u?.category ?? r.category) === "uncategorized"
  }).length

  return { scanned: rows.length, recategorized, transferPairs, aiCategorized, aiErrors, uncategorizedRemaining }
}
