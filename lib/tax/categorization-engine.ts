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
import { aiSuggestCategories, AI_PROMPT_VERSION, type AiCategorizableTx, type AiCategorizeOptions, type AiSuggestion, type AiRunStats } from "./ai-categorizer"

const EMPTY_AI_STATS = (): AiRunStats => ({ batchesSent: 0, batchesFailed: 0, suggestionsParsed: 0, truncatedBatches: 0, capped: false })
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
  // NULL-safe: the type says string, but DB rows cast into ParsedTransaction
  // can carry NULL (ingestion writes '' — direct inserts/tools don't). Flagged
  // 2026-07-05, hit live 2026-07-06 during the S4 repro work.
  const haystacks = [tx.description ?? "", tx.counterparty ?? ""]
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

/** Load active rules for an account (its own + global).
 *  LEAK GUARD (Phase 4, 2026-07-02): workspace-scoped learned rules carry
 *  account_id NULL — without the `.is("workspace_id", null)` filter they would
 *  match the global branch of the OR and leak a scratch workspace's learning
 *  into EVERY client's categorization. Never remove this filter. */
export async function getCategorizationRules(accountId: string): Promise<CategorizationRule[]> {
  const { data, error } = await db
    .from("bank_categorization_rules")
    .select("id, pattern, match_type, category, subcategory, account_id, priority, direction")
    .eq("active", true)
    .is("workspace_id", null)
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
  /** Per-run stats for the ai_categorization_runs record (Phase 0.5). */
  aiStats: AiRunStats
  /** True when aiAssist ran but the candidate filter found NOTHING to send —
   *  the chain brain treats this as DONE, never a no-progress failure. */
  aiNoCandidates?: boolean
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
  // Phase 3R slice 4 (amendment F2): the client's DECLARED related entities
  // (wizard rpt_company_name + other-owned-companies answers). FLAG-ONLY —
  // categorizeTransaction sets is_related_party + a note, never a category;
  // the review card / human answer decides the booking. NEVER feed these into
  // ownNames/nameVariants (that would auto-book conversion — reviewer F2).
  relatedEntities: string[] = [],
): { updates: Map<string, RecatUpdate>; transferPairs: number } {
  // Pass 1: rules. (ai_lean/ai_bucket are ADVISORY review hints — #2 — written
  // for residual rows even when their category stays uncategorized.)
  const updates = new Map<string, RecatUpdate>()
  for (const row of rows) {
    if ((row.notes ?? "").startsWith("manual:")) continue // human corrections win, always
    const isAiTagged = (row.notes ?? "").startsWith("ai:")
    // Zero-amount rows (v4, review F5): card auths/reversals netting to 0
    // cannot move any P&L/BS figure, but left 'uncategorized' they block
    // gate 6 and spam the review as $0.00 questions. Book them into the
    // established zero-impact class deterministically.
    if (Number(row.amount) === 0 && (row.category ?? "uncategorized") === "uncategorized") {
      updates.set(row.id as string, { category: "conversion", subcategory: "zero_amount", notes: "auto: zero-amount" })
      continue
    }
    const next = applyRules(row as unknown as ParsedTransaction, rules, memberNames, relatedEntities)
    // A re-run must never downgrade an AI- OR auto-categorized row back to
    // uncategorized just because no deterministic rule covers it. The auto:
    // guard closes the zero-amount oscillation (dev_task 40b02405): the zero
    // rule above fires only on uncategorized rows, so without this guard every
    // OTHER re-run flipped booked zero rows back open (legacy fallback returns
    // uncategorized), stale note and all — proven by the 3-run repro.
    const isAutoTagged = (row.notes ?? "").startsWith("auto:")
    if ((isAiTagged || isAutoTagged) && next.category === "uncategorized") continue
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
/**
 * PURE (workspace AI parity, 2026-07-02): decide what ONE AI suggestion does to
 * a row. The policy — high-confidence suggestions apply a category ONLY to
 * still-uncategorized rows (tagged "ai:high"); every suggestion's lean/bucket
 * is recorded as an advisory hint; anything else is a no-op. Shared by the
 * client path (below) and the workspace AI pass so the policy can never drift.
 */
export function decideAiSuggestion(
  s: AiSuggestion,
  effectiveCategory: string | undefined,
): { applied: boolean; update: { category?: CategorizedTransaction["category"]; subcategory?: string; notes?: string; ai_lean?: string; ai_bucket?: string } | null } {
  // Sentinel hints (Phase 3R cond. 4 — poison-pill closure): a VALIDATED
  // suggestion always fills BOTH hints, defaulting to 'unsure'/'other' when the
  // model omitted them. The chained-chunk candidate filter skips rows carrying
  // both hints — without sentinels, a lean-less suggestion left its row in the
  // candidate set forever, re-paid by every chunk and every re-run.
  const hint: { ai_lean?: string; ai_bucket?: string } = {
    ai_lean: s.lean ?? "unsure",
    ai_bucket: s.bucket ?? "other",
  }
  if (s.confidence === "high" && effectiveCategory === "uncategorized") {
    // Version-stamped (Phase 0.5): a challenged categorization must trace to
    // the exact prompt that produced it. All note checks use startsWith("ai:").
    return { applied: true, update: { category: s.category, subcategory: s.subcategory, notes: `ai:high@${AI_PROMPT_VERSION}`, ...hint } }
  }
  return { applied: false, update: hint }
}

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
    "id, transaction_date, description, counterparty, amount, currency, balance_after, transaction_ref, bank_name, account_type, category, subcategory, is_related_party, notes, ai_lean, ai_bucket, loc_code, loc_source, loc_confidence",
  )
  if (rows.length === 0) return { scanned: 0, recategorized: 0, transferPairs: 0, aiCategorized: 0, aiErrors: [], uncategorizedRemaining: 0, aiStats: EMPTY_AI_STATS() }

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

  // Declared related entities (Phase 3R slice 4): the wizard's rpt_company_name
  // + other_owned_companies answers flag matching rows (is_related_party +
  // note) so a $183k transfer to the client's OWN other company can never
  // silently read as a vendor expense. Flag-only; humans decide the booking.
  const { fetchDeclaredEntities } = await import("./declared-entities")
  const relatedEntities = await fetchDeclaredEntities(supabaseAdmin, accountId, taxYear)

  // Passes 1 (rules) + 2 (transfer pairs) + 2b (own-entity self-transfers): the
  // pure deterministic core, extracted so the standalone P&L workspace tool
  // categorizes IDENTICALLY to this client path (no divergence — parity
  // guarantee). See computeRecategorizationUpdates above.
  const { updates, transferPairs } = computeRecategorizationUpdates(rows, rules, memberNames, companyName, relatedEntities)

  // Pass 3 (optional, Slice 5b): AI assist on what's STILL uncategorized after
  // the deterministic passes. Only high-confidence suggestions are applied,
  // tagged "ai:high" so staff and the review screen can always tell them apart.
  // Persist the DETERMINISTIC updates FIRST (Phase 0.3, 2026-07-03): the old
  // single end-of-run persist made rule/transfer results wait behind the
  // (minutes-long) AI loop — a killed run lost EVERYTHING, including work that
  // never needed the AI. Deterministic writes land now; the AI pass below
  // persists per batch.
  let recategorized = 0
  for (const [id, u] of Array.from(updates.entries())) {
    const orig = rows.find(r => r.id === id)
    if (!orig) continue
    const nextCategory = u.category ?? (orig.category as string)
    const nextSub = u.subcategory ?? ((orig.subcategory as string) ?? "")
    const catChanged = nextCategory !== orig.category || nextSub !== ((orig.subcategory as string) ?? "")
    if (!catChanged && !u.notes) continue
    const payload: Record<string, unknown> = { category: nextCategory, subcategory: nextSub }
    if (u.notes) payload.notes = u.notes
    const { error: upErr } = await supabaseAdmin
      .from("bank_transactions")
      .update(payload)
      .eq("id", id)
    if (upErr) throw new Error(`Failed to update transaction ${id}: ${upErr.message}`)
    recategorized++
  }

  // Effective category per row after the deterministic pass (source of truth
  // for the AI candidate filter + apply policy below).
  const effCat = new Map(rows.map(r => [r.id as string, updates.get(r.id as string)?.category ?? (r.category as string)]))

  let aiCategorized = 0
  let aiErrors: string[] = []
  let aiStats = EMPTY_AI_STATS()
  let aiNoCandidates = false
  if (opts?.aiAssist) {
    // Option B (#2): label the FULL reviewable set for advisory hints — outflows
    // booked as a business cost (expense/fee/cogs) or still undecided, and
    // inflows booked as income or undecided — so the client review is pre-sorted
    // even for rows a rule already expensed. Skip rows that already have both
    // hints (idempotent + cost). Category is still APPLIED only to uncategorized
    // rows (a rule/AI never auto-decides personal — that's the owner's call).
    const toLabel = rows.filter(r => {
      if ((r.notes ?? "").startsWith("manual:")) return false
      if ((r.ai_lean ?? null) !== null && (r.ai_bucket ?? null) !== null) return false
      const cat = effCat.get(r.id as string) as string
      const amt = Number(r.amount)
      return amt < 0
        ? ["uncategorized", "expense", "fee", "cogs"].includes(cat)
        : ["uncategorized", "income"].includes(cat)
    })
    if (toLabel.length === 0) aiNoCandidates = true
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

      const written = new Set<string>()
      // Persist one suggestion via the shared pure policy. TOCTOU guard
      // (re-review COND-3): applied-category writes carry
      // .eq('category','uncategorized') so a human answer or re-run landing
      // mid-AI is never overwritten by a verdict decided on stale data.
      const persistSuggestion = async (s: AiSuggestion) => {
        const d = decideAiSuggestion(s, effCat.get(s.id))
        if (!d.update) return
        const payload: Record<string, unknown> = {}
        if (d.update.category) payload.category = d.update.category
        if (d.update.subcategory !== undefined) payload.subcategory = d.update.subcategory
        if (d.update.notes) payload.notes = d.update.notes
        if (d.update.ai_lean !== undefined) payload.ai_lean = d.update.ai_lean
        if (d.update.ai_bucket !== undefined) payload.ai_bucket = d.update.ai_bucket
        let q = supabaseAdmin.from("bank_transactions").update(payload as never).eq("id", s.id)
        if (d.applied) q = q.eq("category", "uncategorized")
        const { error: aiErr } = await q
        if (aiErr) throw new Error(`Failed to update transaction ${s.id}: ${aiErr.message}`)
        if (d.applied) { aiCategorized++; effCat.set(s.id, d.update.category as string) }
        written.add(s.id)
      }

      // Per-batch persistence (Phase 0.3): each batch lands before the next
      // API call — a killed run keeps everything already paid for.
      const ai = await aiSuggestCategories(
        txs,
        { companyName: companyName || "the company", memberNames, bankNames, businessDescription, buckets },
        {
          ...opts.aiOptions,
          onBatch: async (batchSuggestions) => {
            for (const s of batchSuggestions) await persistSuggestion(s)
          },
        },
      )
      aiErrors = ai.errors
      aiStats = ai.stats
      // Reconcile anything a failed mid-run onBatch write missed.
      for (const s of ai.suggestions) {
        if (!written.has(s.id)) await persistSuggestion(s)
      }
    }
  }

  const uncategorizedRemaining = Array.from(effCat.values()).filter(c => c === "uncategorized").length

  // Location labeling (Phase B2, 2026-07-08 — books twin of the workspace
  // block in workspace-recategorize.ts): deterministic-only stamping so the
  // client's country/period cards see locations on rows that never passed
  // through a workspace (wizard-ingested books). Same rules as the workspace:
  // idempotent pure extractors; a fresh deterministic hit outranks and
  // overwrites an 'ai' stamp (carried over by Save-to-client); a no-hit must
  // never CLEAR an 'ai' stamp (the extractors are blind to language/city
  // tokens the AI read). AI-place itself stays workspace-only.
  const { inferLocation } = await import("./merchant-locations")
  for (const r of rows) {
    const hit = inferLocation({
      description: (r.description as string | null) ?? null,
      counterparty: (r.counterparty as string | null) ?? null,
      amount: Number(r.amount),
      category: (effCat.get(r.id as string) as string | null) ?? (r.category as string | null),
    })
    const cur = r as unknown as { loc_code: string | null; loc_source: string | null; loc_confidence: string | null }
    if (!hit && cur.loc_source === "ai") continue
    const next = hit ?? { loc_code: null, loc_source: null, loc_confidence: null }
    if (cur.loc_code === next.loc_code && cur.loc_source === next.loc_source && cur.loc_confidence === next.loc_confidence) continue
    const { error: locErr } = await supabaseAdmin
      .from("bank_transactions")
      .update(next as never)
      .eq("id", r.id as string)
    if (locErr) throw new Error(`Failed to stamp location on transaction ${r.id}: ${locErr.message}`)
  }

  return { scanned: rows.length, recategorized, transferPairs, aiCategorized, aiErrors, uncategorizedRemaining, aiStats, ...(aiNoCandidates ? { aiNoCandidates } : {}) }
}
