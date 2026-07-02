/**
 * Workspace recategorization — the standalone P&L tool's twin of
 * `recategorizeAccountYear`, run against `pnl_workspace_transactions`.
 *
 * PARITY: reuses the SAME pure core (`computeRecategorizationUpdates`) as the
 * client path, so a workspace categorizes IDENTICALLY. ISOLATION: writes only
 * to the workspace table; NO rule-learning, NO AI job enqueue, NO attestation —
 * a workspace never touches real client/global state.
 *
 * Rules: a forked workspace loads its linked client's rules + global rules (so
 * it matches the client); a blank workspace loads GLOBAL rules only.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { fetchAllPaged } from "@/lib/bank-transactions-fetch"
import {
  computeRecategorizationUpdates,
  getCategorizationRules,
  type CategorizableRow,
  type CategorizationRule,
} from "./categorization-engine"

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
 * client path. (No AI-assist pass — a workspace is deterministic by design.)
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
