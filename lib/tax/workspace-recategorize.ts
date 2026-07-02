/**
 * Workspace recategorization — the standalone P&L tool's twin of
 * `recategorizeAccountYear`, run against `pnl_workspace_transactions`.
 *
 * PARITY: reuses the SAME pure core (`computeRecategorizationUpdates`) as the
 * client path, so a workspace categorizes IDENTICALLY. ISOLATION: writes only
 * to the workspace table; NO rule-learning here, NO attestation — a workspace
 * never touches real client/global state.
 *
 * AI pass (2026-07-02, deliberate design change — was "deterministic by
 * design"): `recategorizeWorkspaceAi` runs the SAME AI-assist policy as the
 * client path (shared `decideAiSuggestion`) on whatever the deterministic
 * passes left uncategorized. It runs via the `recategorize_workspace_ai` job,
 * enqueued by the Generate P&L action — one pass per generation, never on a
 * partial upload set.
 *
 * Rules: a forked workspace loads its linked client's rules + global rules (so
 * it matches the client); a blank workspace loads GLOBAL rules only.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { fetchAllPaged } from "@/lib/bank-transactions-fetch"
import {
  computeRecategorizationUpdates,
  getCategorizationRules,
  decideAiSuggestion,
  type CategorizableRow,
  type CategorizationRule,
} from "./categorization-engine"
import { aiSuggestCategories, type AiCategorizableTx, type AiCategorizeOptions } from "./ai-categorizer"
import { getExpenseBuckets } from "./expense-buckets"

// Workspace tables are not yet in the generated database.types.ts — same
// untyped-client pattern the categorization engine uses for bank_categorization_rules.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const WS_TX_COLUMNS =
  "id, transaction_date, description, counterparty, amount, currency, balance_after, transaction_ref, bank_name, account_type, category, subcategory, is_related_party, notes, ai_lean, ai_bucket"

export interface WorkspaceRecategorizeResult {
  scanned: number
  recategorized: number
  transferPairs: number
  uncategorizedRemaining: number
}

/** Every workspace transaction (paged past the 1000-row cap), engine-shaped. */
async function fetchAllWorkspaceTransactions(workspaceId: string): Promise<CategorizableRow[]> {
  return fetchAllPaged<CategorizableRow>(async (from, to) => {
    const { data, error } = await db
      .from("pnl_workspace_transactions")
      .select(WS_TX_COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("id", { ascending: true })
      .range(from, to)
    if (error) throw new Error(`Failed to load workspace transactions: ${error.message}`)
    return (data ?? []) as CategorizableRow[]
  })
}

/** Load the rules the workspace should categorize with (fork → client+global; blank → global). */
async function loadRulesForWorkspace(linkedAccountId: string | null): Promise<CategorizationRule[]> {
  if (linkedAccountId) return getCategorizationRules(linkedAccountId)
  const { data, error } = await db
    .from("bank_categorization_rules")
    .select("id, pattern, match_type, category, subcategory, account_id, priority, direction")
    .eq("active", true)
    .is("account_id", null)
    .order("priority", { ascending: true })
  if (error) throw new Error(`Failed to load global categorization rules: ${error.message}`)
  return (data ?? []) as CategorizationRule[]
}

/**
 * Re-categorize one workspace's transactions with the shared deterministic core,
 * persisting only changed rows. Idempotent + re-runnable, exactly like the
 * client path. (The AI-assist pass is separate — `recategorizeWorkspaceAi`,
 * run as a job at Generate time.)
 */
export async function recategorizeWorkspace(
  workspaceId: string,
  opts: { linkedAccountId: string | null; companyName: string; memberNames: string[] },
): Promise<WorkspaceRecategorizeResult> {
  const rows = await fetchAllWorkspaceTransactions(workspaceId)
  if (rows.length === 0) return { scanned: 0, recategorized: 0, transferPairs: 0, uncategorizedRemaining: 0 }

  const rules = await loadRulesForWorkspace(opts.linkedAccountId)
  const { updates, transferPairs } = computeRecategorizationUpdates(rows, rules, opts.memberNames, opts.companyName)

  let recategorized = 0
  for (const [id, u] of Array.from(updates.entries())) {
    const orig = rows.find(r => r.id === id)
    if (!orig) continue
    const nextCategory = u.category ?? (orig.category as string)
    const nextSub = u.subcategory ?? ((orig.subcategory as string) ?? "")
    const catChanged = nextCategory !== orig.category || nextSub !== ((orig.subcategory as string) ?? "")
    if (!catChanged && !u.notes && u.ai_lean === undefined && u.ai_bucket === undefined) continue
    const payload: Record<string, unknown> = { category: nextCategory, subcategory: nextSub }
    if (u.notes) payload.notes = u.notes
    if (u.ai_lean !== undefined) payload.ai_lean = u.ai_lean
    if (u.ai_bucket !== undefined) payload.ai_bucket = u.ai_bucket
    const { error } = await db.from("pnl_workspace_transactions").update(payload).eq("id", id)
    if (error) throw new Error(`Failed to update workspace transaction ${id}: ${error.message}`)
    recategorized++
  }

  const uncategorizedRemaining = rows.filter(r => {
    const u = updates.get(r.id as string)
    return (u?.category ?? r.category) === "uncategorized"
  }).length

  return { scanned: rows.length, recategorized, transferPairs, uncategorizedRemaining }
}

export interface WorkspaceAiResult {
  scanned: number
  aiCategorized: number
  labeled: number
  aiErrors: string[]
  uncategorizedRemaining: number
}

/**
 * AI-assist pass for one workspace — the twin of `recategorizeAccountYear`'s
 * pass 3, byte-identical policy via the shared `decideAiSuggestion`:
 * high-confidence suggestions categorize STILL-UNCATEGORIZED rows only (tagged
 * "ai:high"); every suggestion's lean/bucket lands as advisory hints; rows a
 * human corrected ("manual:" notes) are untouched. Differences from the client
 * path, both structural: context comes from the workspace roster (no
 * tax_return_submissions business description), and it always runs AFTER the
 * deterministic pass has persisted (so categories are read fresh, no in-memory
 * updates map to merge).
 */
export async function recategorizeWorkspaceAi(
  workspaceId: string,
  opts: { companyName: string; memberNames: string[]; aiOptions?: AiCategorizeOptions },
): Promise<WorkspaceAiResult> {
  const rows = await fetchAllWorkspaceTransactions(workspaceId)
  if (rows.length === 0) return { scanned: 0, aiCategorized: 0, labeled: 0, aiErrors: [], uncategorizedRemaining: 0 }

  // Candidate selection — same policy as the client path: label outflows booked
  // as a business cost or undecided + inflows booked as income or undecided;
  // skip manual rows and rows that already carry both hints (idempotent + cost).
  const toLabel = rows.filter(r => {
    if (((r.notes as string | null) ?? "").startsWith("manual:")) return false
    if (((r.ai_lean as string | null) ?? null) !== null && ((r.ai_bucket as string | null) ?? null) !== null) return false
    const cat = r.category as string
    const amt = Number(r.amount)
    return amt < 0
      ? ["uncategorized", "expense", "fee", "cogs"].includes(cat)
      : ["uncategorized", "income"].includes(cat)
  })
  const uncatBefore = rows.filter(r => (r.category as string) === "uncategorized").length
  if (toLabel.length === 0) return { scanned: rows.length, aiCategorized: 0, labeled: 0, aiErrors: [], uncategorizedRemaining: uncatBefore }

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
    { companyName: opts.companyName || "the company", memberNames: opts.memberNames, bankNames, buckets },
    opts.aiOptions,
  )

  const catById = new Map(rows.map(r => [r.id as string, r.category as string]))
  let aiCategorized = 0
  let labeled = 0
  for (const s of ai.suggestions) {
    const d = decideAiSuggestion(s, catById.get(s.id))
    if (!d.update) continue
    const payload: Record<string, unknown> = {}
    if (d.update.category) payload.category = d.update.category
    if (d.update.subcategory !== undefined) payload.subcategory = d.update.subcategory
    if (d.update.notes) payload.notes = d.update.notes
    if (d.update.ai_lean !== undefined) payload.ai_lean = d.update.ai_lean
    if (d.update.ai_bucket !== undefined) payload.ai_bucket = d.update.ai_bucket
    const { error } = await db.from("pnl_workspace_transactions").update(payload).eq("id", s.id)
    if (error) throw new Error(`Failed to update workspace transaction ${s.id}: ${error.message}`)
    if (d.applied) { aiCategorized++; catById.set(s.id, d.update.category as string) }
    labeled++
  }

  const uncategorizedRemaining = Array.from(catById.values()).filter(c => c === "uncategorized").length
  return { scanned: rows.length, aiCategorized, labeled, aiErrors: ai.errors, uncategorizedRemaining }
}
