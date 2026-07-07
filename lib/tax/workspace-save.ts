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
  /** Suppress the client "your P&L is ready" dispatch — for mid-rework
   * re-saves where staff will announce manually. Default: notify. */
  skipClientNotification?: boolean
  /** DI seam for tests. */
  notifyFn?: (params: {
    account_id: string
    title: { en: string; it: string }
    message: { en: string; it: string }
    link: string
  }) => Promise<unknown>
}

/** PURE — the client-facing "your P&L is ready" copy for a save. The link is
 * year-scoped: it lands on the right tab of the portal year picker AND gives
 * the action-required engine a per-year dedup scope (two years saved the same
 * day both announce). */
export function buildSaveToClientNotification(taxYear: number): {
  title: { en: string; it: string }
  message: { en: string; it: string }
  link: string
} {
  return {
    title: {
      en: `Review your Profit & Loss — ${taxYear}`,
      it: `Controlla il tuo Conto Economico — ${taxYear}`,
    },
    message: {
      en: `We've prepared your ${taxYear} Profit & Loss and Balance Sheet from your bank statements. Please open it in the portal, answer the few items that need your decision, and confirm the numbers so we can move forward.`,
      it: `Abbiamo preparato il tuo Conto Economico e Stato Patrimoniale ${taxYear} dai tuoi estratti conto. Aprilo nel portale, rispondi alle voci che richiedono una tua decisione e conferma i numeri così possiamo procedere.`,
    },
    link: `/portal/tax-financials?year=${taxYear}`,
  }
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

  // Auto-learn promotion (Phase 4, 2026-07-02): a blank workspace's learned
  // rules become the client's permanent per-account memory — next year's
  // wizard/fork auto-applies them via the existing rule loading. Runs BEFORE
  // the recategorize below so the promoted rules already apply to this save.
  // Fire-and-forget: promotion must never fail the save.
  let promotedRules = 0
  try {
    // Untyped client on purpose — the typed builder + a table outside
    // database.types.ts triggers TS "type instantiation is excessively deep"
    // (same erasure pattern as makeSupabaseRuleStore).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rulesDb = supabaseAdmin as any
    const { data: wsRules } = await rulesDb
      .from("bank_categorization_rules")
      .select("pattern, match_type, category, subcategory, direction, created_by")
      .eq("workspace_id", workspaceId)
      .eq("active", true) as { data: Array<{ pattern: string; match_type: string; category: string; subcategory: string; direction: string; created_by: string | null }> | null }
    if (wsRules && wsRules.length > 0) {
      const { makeSupabaseRuleStore } = await import("./learned-rules")
      const store = makeSupabaseRuleStore(supabaseAdmin as never)
      for (const r of wsRules) {
        const existing = await store.findRule({ account_id: targetAccountId }, r.pattern, r.direction)
        if (existing) {
          await store.updateRule(existing.id, {
            category: r.category, subcategory: r.subcategory, active: true, source: "learned",
            updated_at: new Date().toISOString(),
          })
        } else {
          await store.insertRule({
            pattern: r.pattern, match_type: r.match_type, category: r.category, subcategory: r.subcategory,
            account_id: targetAccountId, workspace_id: null, direction: r.direction,
            priority: 100, active: true, source: "learned",
            notes: `promoted from P&L workspace ${workspaceId} on save`,
            created_by: r.created_by ?? actor,
          })
        }
        promotedRules++
      }
    }
  } catch (e) {
    console.error("[workspace-save] learned-rule promotion failed (rows saved fine):", e)
  }

  // Country-policy promotion (S4, 2026-07-06): the workspace's active
  // full-year country answers become the client's STANDING policies —
  // next year's workspace replays them with zero taps (the location half of
  // the year-over-year memory; merchant rules cover the other half above).
  // Same contract as rule promotion: fire-and-forget, never fails the save.
  let promotedPolicies = 0
  try {
    const { data: wsMeta } = await db
      .from("pnl_workspaces")
      .select("tax_year")
      .eq("id", workspaceId)
      .maybeSingle()
    const wsTaxYear = Number(wsMeta?.tax_year)
    if (Number.isInteger(wsTaxYear)) {
      const { resolveCountryPolicies, resolveAccountResidenceIso } = await import("./country-policy-sweep")
      const { data: answerRows } = await db
        .from("pnl_period_answers")
        .select("id, loc_codes, period_start, period_end, choice, actor_role, created_at, undone_at, policy_revoked_at")
        .eq("workspace_id", workspaceId)
      const residenceCountry = await resolveAccountResidenceIso(targetAccountId)
      // Workspace-level policies only: account-level ones already live on the
      // account (promoting them back to themselves would be a no-op loop).
      const policies = resolveCountryPolicies({
        workspaceAnswers: (answerRows ?? []) as never,
        accountPolicies: [],
        taxYear: wsTaxYear,
        residenceCountry,
      })
      for (const pol of policies) {
        const { error } = await db
          .from("account_location_policies")
          .upsert({
            account_id: targetAccountId,
            loc_code: pol.loc_code,
            choice: pol.choice,
            active: true,
            promoted_from_workspace: workspaceId,
            promoted_batch_id: pol.source_id,
            created_by: actor,
            updated_at: new Date().toISOString(),
          }, { onConflict: "account_id,loc_code" })
        if (error) throw new Error(error.message)
        promotedPolicies++
      }
    }
  } catch (e) {
    console.error("[workspace-save] country-policy promotion failed (rows saved fine):", e)
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
      summary: `Saved P&L workspace to client (${decision.action}): +${inserted} row(s)${deleted ? `, -${deleted} replaced` : ""}${promotedRules ? `, ${promotedRules} learned rule(s) promoted` : ""}${promotedPolicies ? `, ${promotedPolicies} country polic${promotedPolicies === 1 ? "y" : "ies"} promoted` : ""} for tax year ${taxYear}`,
      details: { workspace_id: workspaceId, tax_year: taxYear, mode: decision.action, inserted, deleted, backup_path: backupPath ?? null, promoted_rules: promotedRules, promoted_policies: promotedPolicies },
    } as never)
  } catch (e) {
    console.error("[workspace-save] audit log insert failed (save already applied):", e)
  }

  // Client dispatch (Phase B, 2026-07-08): publishing a P&L to a client's books
  // is a CLIENT ACTION (review + answer + confirm), so it announces itself —
  // chat + bell + email via the shared action-required engine (per-recipient
  // locale, 10-min dedup on the year-scoped link). Fire-and-forget: a
  // notification failure must never fail the save. The wizard path has its own
  // equivalent (lib/jobs/ingest-complete-notify.ts) — this covers the
  // staff-workspace publish path that bypasses ingest jobs.
  if (!input.skipClientNotification) {
    try {
      const notify = input.notifyFn
        ?? (await import("@/lib/portal/action-required")).notifyClientActionRequired
      await notify({ account_id: targetAccountId, ...buildSaveToClientNotification(taxYear) })
    } catch (e) {
      console.error("[workspace-save] client notification failed (save already applied):", e)
    }
  }

  return { ok: true, action: decision.action, inserted, deleted, backupPath }
}
