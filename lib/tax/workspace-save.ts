/**
 * Save a standalone P&L workspace TO a real client — the ONLY code in the tool
 * that writes to real client books (`bank_transactions`). High-stakes, so it is
 * heavily guarded:
 *
 *  - CONCURRENCY: refuses while the client's own wizard ingestion is in flight
 *    (`countInFlightIngestJobs`), so a save never races real rows.
 *  - NON-DESTRUCTIVE BY DEFAULT: if the target account+year already has
 *    transactions, the caller MUST choose `merge` (add-only) or `replace`
 *    (overwrite). Never silently mixes.
 *  - REVERSIBLE REPLACE: before deleting the client's rows, a full JSON snapshot
 *    is written to storage; its path is recorded in the audit entry for restore.
 *  - AUDITED: every save writes an `action_log` row (actor, mode, rows ±).
 *
 * After writing it runs the client's normal `recategorizeAccountYear` +
 * `resetFinancialsAttestation` (called, not modified).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { fetchAllPaged } from "@/lib/bank-transactions-fetch"
import { countInFlightIngestJobs } from "./ingest-status"
import { recategorizeAccountYear } from "./categorization-engine"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export type SaveMode = "merge" | "replace"

export interface SaveDecision {
  action: "insert" | "merge" | "replace" | "refuse"
  reason?: string
}

/**
 * PURE decision: given the target's existing row count, in-flight ingest jobs,
 * and the caller's chosen mode, what should a save do? Unit-tested in isolation.
 */
export function decideSaveToClient(input: {
  existingCount: number
  inFlightJobs: number
  mode?: SaveMode
}): SaveDecision {
  if (input.inFlightJobs > 0) {
    return { action: "refuse", reason: "The client's statements are still being processed — try again once ingestion finishes." }
  }
  if (input.existingCount === 0) return { action: "insert" }
  if (input.mode === "merge") return { action: "merge" }
  if (input.mode === "replace") return { action: "replace" }
  return {
    action: "refuse",
    reason: `This client already has ${input.existingCount} transaction(s) for this year. Choose Merge (add only) or Replace (overwrite) to proceed.`,
  }
}

export interface SaveToClientInput {
  workspaceId: string
  targetAccountId: string
  taxYear: number
  mode?: SaveMode
  /** Staff identity for the audit trail. */
  actor: string
}

export interface SaveToClientResult {
  ok: boolean
  action: SaveDecision["action"]
  reason?: string
  inserted: number
  deleted: number
  /** Storage path of the pre-replace snapshot (Replace only). */
  backupPath?: string
}

const WS_SAVE_COLUMNS =
  "tax_year, transaction_date, description, category, subcategory, counterparty, amount, currency, balance_after, bank_name, account_type, transaction_ref, source_file_id, is_related_party, notes"

interface WsSaveRow {
  tax_year: number
  transaction_date: string
  description: string | null
  category: string | null
  subcategory: string | null
  counterparty: string | null
  amount: number | string
  currency: string | null
  balance_after: number | null
  bank_name: string | null
  account_type: string | null
  transaction_ref: string
  source_file_id: string | null
  is_related_party: boolean | null
  notes: string | null
}

/** Every workspace transaction (paged), the columns needed to write to bank_transactions. */
async function fetchWorkspaceRowsForSave(workspaceId: string): Promise<WsSaveRow[]> {
  return fetchAllPaged<WsSaveRow>(async (from, to) => {
    const { data, error } = await db
      .from("pnl_workspace_transactions")
      .select(WS_SAVE_COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("id", { ascending: true })
      .range(from, to)
    if (error) throw new Error(`Failed to load workspace transactions: ${error.message}`)
    return (data ?? []) as WsSaveRow[]
  })
}

/** Dump the client's existing rows for account+year to storage JSON (restore point). */
async function backupClientYear(accountId: string, taxYear: number): Promise<string> {
  const rows = await fetchAllPaged<Record<string, unknown>>(async (from, to) => {
    const { data, error } = await supabaseAdmin
      .from("bank_transactions")
      .select("*")
      .eq("account_id", accountId)
      .eq("tax_year", taxYear)
      .order("id", { ascending: true })
      .range(from, to)
    if (error) throw new Error(`Backup read failed: ${error.message}`)
    return (data ?? []) as Record<string, unknown>[]
  })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const path = `pnl-workspaces/backups/${accountId}/${taxYear}/${stamp}.json`
  const { error } = await supabaseAdmin.storage
    .from("onboarding-uploads")
    .upload(path, Buffer.from(JSON.stringify({ account_id: accountId, tax_year: taxYear, rows })), {
      contentType: "application/json",
      upsert: true,
    })
  if (error) throw new Error(`Could not write the safety backup before Replace: ${error.message}`)
  return path
}

export async function saveWorkspaceToClient(input: SaveToClientInput): Promise<SaveToClientResult> {
  const { workspaceId, targetAccountId, taxYear, mode, actor } = input

  const wsRows = (await fetchWorkspaceRowsForSave(workspaceId)).filter(r => Number(r.tax_year) === taxYear)
  if (wsRows.length === 0) {
    return { ok: false, action: "refuse", reason: "This workspace has no transactions to save.", inserted: 0, deleted: 0 }
  }

  // Existing rows in the client's real books for this account+year.
  const { count: existingCount } = await supabaseAdmin
    .from("bank_transactions")
    .select("id", { count: "exact", head: true })
    .eq("account_id", targetAccountId)
    .eq("tax_year", taxYear)

  const inFlightJobs = await countInFlightIngestJobs(targetAccountId, taxYear)
  const decision = decideSaveToClient({ existingCount: existingCount ?? 0, inFlightJobs, mode })
  if (decision.action === "refuse") {
    return { ok: false, action: "refuse", reason: decision.reason, inserted: 0, deleted: 0 }
  }

  // Replace → snapshot then delete the client's rows for this year.
  let deleted = 0
  let backupPath: string | undefined
  if (decision.action === "replace") {
    backupPath = await backupClientYear(targetAccountId, taxYear)
    const { data: del, error: delErr } = await supabaseAdmin
      .from("bank_transactions")
      .delete()
      .eq("account_id", targetAccountId)
      .eq("tax_year", taxYear)
      .select("id")
    if (delErr) throw new Error(`Replace failed while clearing existing rows (backup saved at ${backupPath}): ${delErr.message}`)
    deleted = del?.length ?? 0
  }

  // Insert workspace rows into the client's books — same dedup contract as the
  // portal path (identical row shape; ignoreDuplicates keeps merge idempotent).
  let inserted = 0
  for (const tx of wsRows) {
    const { error } = await supabaseAdmin
      .from("bank_transactions")
      .upsert({
        account_id: targetAccountId,
        tax_year: taxYear,
        transaction_date: tx.transaction_date,
        description: tx.description,
        category: tx.category,
        subcategory: tx.subcategory,
        counterparty: tx.counterparty,
        amount: tx.amount,
        currency: tx.currency,
        balance_after: tx.balance_after,
        bank_name: tx.bank_name,
        account_type: tx.account_type,
        transaction_ref: tx.transaction_ref,
        source_file_id: tx.source_file_id,
        is_related_party: tx.is_related_party,
        notes: tx.notes,
      } as never, { onConflict: "account_id,transaction_ref,transaction_date,amount", ignoreDuplicates: true })
    if (!error) inserted++
  }

  // Client-path follow-ups (called, never modified).
  try {
    await recategorizeAccountYear(targetAccountId, taxYear)
  } catch (e) {
    console.error("[workspace-save] recategorization failed (rows saved fine):", e)
  }
  try {
    const { resetFinancialsAttestation } = await import("./attestation")
    await resetFinancialsAttestation(targetAccountId, taxYear, `saved from P&L workspace ${workspaceId} (${decision.action})`)
  } catch (e) {
    console.error("[workspace-save] attestation reset failed:", e)
  }

  // Audit — every write to real client books is logged.
  try {
    await supabaseAdmin.from("action_log").insert({
      actor,
      action_type: "pnl_workspace_save_to_client",
      table_name: "bank_transactions",
      record_id: workspaceId,
      account_id: targetAccountId,
      summary: `Saved P&L workspace to client (${decision.action}): +${inserted} row(s)${deleted ? `, -${deleted} replaced` : ""} for tax year ${taxYear}`,
      details: { workspace_id: workspaceId, tax_year: taxYear, mode: decision.action, inserted, deleted, backup_path: backupPath ?? null },
    } as never)
  } catch (e) {
    console.error("[workspace-save] audit log insert failed (save already applied):", e)
  }

  return { ok: true, action: decision.action, inserted, deleted, backupPath }
}
