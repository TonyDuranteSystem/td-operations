/**
 * Workspace CSV/PDF ingestion — the standalone P&L tool's twin of
 * `ingestPortalCsv`, writing to `pnl_workspace_transactions` (never
 * bank_transactions). Reuses the SAME pure parser + categorizer, then the
 * shared deterministic recategorization core via `recategorizeWorkspace`.
 *
 * ISOLATION: nothing here touches a real client, a global catalog, or the job
 * queue. Structural dedup is the workspace unique index
 * (workspace_id, transaction_ref, transaction_date, amount); the informational
 * L1/L2/L3 duplicate ALERT (which reads bank_transactions) is intentionally
 * omitted for the scratch tool — the index still prevents duplicate rows.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { parseBankStatement, categorizeTransaction } from "@/lib/bank-statement-parser"
import { sha256Hex, uploadSourceId } from "./statement-uploads"
import { recategorizeWorkspace } from "./workspace-recategorize"
import { buildAccountRef } from "./bank-identity"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export interface WorkspaceIngestInput {
  workspaceId: string
  taxYear: number
  /** Free-text bank name — fallback identity only, never routing. */
  bankLabel: string
  /** Staff-provided account number/label (account_number-mode institutions). */
  accountNumber?: string | null
  buffer: Buffer
  fileName: string
  /** Fork → the linked client (for rules); blank → null. */
  linkedAccountId: string | null
  /** Entity name — own-entity self-transfer detection. */
  companyName: string
  /** Workspace member display names — related-party detection. */
  memberNames: string[]
}

export interface WorkspaceIngestResult {
  ok: boolean
  error?: string
  alert?: string | null
  inserted: number
  parsed: number
  months: string[]
  bankDetected: string
  uncategorizedRemaining: number
  sourceFileId: string
  /** S1: the file is QUARANTINED pending a one-tap staff format confirmation. */
  quarantine?: { mapping_id: string | null; fingerprint: string; bank_label: string; ambiguities: string[]; sample: unknown }
}

export async function ingestWorkspaceCsv(input: WorkspaceIngestInput): Promise<WorkspaceIngestResult> {
  const { workspaceId, taxYear, bankLabel, accountNumber, buffer, fileName, linkedAccountId, companyName, memberNames } = input
  const sha = sha256Hex(buffer)
  const sourceFileId = uploadSourceId(sha)
  const fail = (error: string): WorkspaceIngestResult => ({
    ok: false, error, inserted: 0, parsed: 0, months: [], bankDetected: bankLabel, uncategorizedRemaining: 0, sourceFileId,
  })

  // 0. Idempotency short-circuit — this exact file already ingested into this workspace.
  const { count: existingForSource } = await db
    .from("pnl_workspace_transactions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("source_file_id", sourceFileId)
  if ((existingForSource ?? 0) > 0) {
    return {
      ok: true,
      alert: `This file was already processed — ${existingForSource} transaction(s) are on file.`,
      inserted: 0, parsed: existingForSource ?? 0, months: [], bankDetected: bankLabel,
      uncategorizedRemaining: 0, sourceFileId,
    }
  }

  // 1. Parse by real file type (PDF → AI extractor, CSV → deterministic parsers).
  const lower = fileName.toLowerCase()
  const mimeType = lower.endsWith(".pdf")
    ? "application/pdf"
    : lower.endsWith(".zip") || lower.endsWith(".x-zip-compressed")
      ? "application/zip"
      : "text/csv"
  // S1 (2026-07-07): unknown CSV layouts go through the learned-mapping layer
  // (stored fingerprint → heuristic/AI column-role proposal → deterministic
  // verifier → auto-accept or quarantine). The store is injected here so the
  // parser itself stays pure.
  const { makeSupabaseMappingStore } = await import("@/lib/bank-format-mappings")
  const parsed = await parseBankStatement(buffer, fileName, mimeType, { taxYear, mappingStore: makeSupabaseMappingStore(db) })
  if (parsed.extraction_method === "quarantined" && parsed.quarantine) {
    return {
      ok: false,
      error: parsed.errors[0] ?? "This file's format needs a one-tap staff confirmation before it can be read.",
      inserted: 0, parsed: 0, months: [], bankDetected: parsed.quarantine.bank_label,
      uncategorizedRemaining: 0, sourceFileId,
      quarantine: parsed.quarantine,
    }
  }
  if (parsed.transactions.length === 0) {
    const detail = parsed.errors.length ? ` (${parsed.errors[0]})` : ""
    return fail(
      `We could not read any transactions from this file${detail}. ` +
      `Upload each statement exactly as the bank exports it — a CSV or the official PDF for the full period. ` +
      `Do not merge or edit the files.`,
    )
  }

  // 2. Categorize (legacy built-ins + member detection) and keep the tax year.
  const bankDetected = parsed.bank_name && parsed.bank_name !== "unknown" ? parsed.bank_name : bankLabel
  // Canonical institution name + account identity, once per file (one file = one account).
  const ident = buildAccountRef({ rawBankName: bankDetected, accountNumber })
  const categorized = parsed.transactions
    .map(tx => categorizeTransaction(tx, memberNames, []))
    .filter(tx => tx.transaction_date.startsWith(String(taxYear)))
    .map(tx => ({ ...tx, bank_name: ident.canonical, account_ref: ident.account_ref }))

  if (categorized.length === 0) {
    return fail(
      `This file contains no ${taxYear} transactions (it covers a different period). ` +
      `Export the entire year ${taxYear} — January 1 to December 31 — and upload that file.`,
    )
  }

  const months = Array.from(new Set(categorized.map(t => t.transaction_date.slice(0, 7)))).sort()

  // 3. Insert — the workspace unique index drops exact-duplicate rows.
  let inserted = 0
  let firstInsertError: string | null = null
  for (const tx of categorized) {
    const { error } = await db
      .from("pnl_workspace_transactions")
      .upsert({
        workspace_id: workspaceId,
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
        account_ref: tx.account_ref,
        transaction_ref: tx.transaction_ref,
        source_file_id: sourceFileId,
        is_related_party: tx.is_related_party,
        notes: tx.notes,
      }, { onConflict: "workspace_id,transaction_ref,transaction_date,amount", ignoreDuplicates: true })
    if (!error) inserted++
    else if (!firstInsertError) firstInsertError = error.message
  }
  if (inserted === 0 && categorized.length > 0 && firstInsertError) {
    return fail(`The file was read correctly (${categorized.length} transactions) but could not be saved: ${firstInsertError}.`)
  }

  // 4. Deterministic categorization passes (shared parity core) — no AI, no job.
  let uncategorizedRemaining = 0
  try {
    const recat = await recategorizeWorkspace(workspaceId, { linkedAccountId, companyName, memberNames })
    uncategorizedRemaining = recat.uncategorizedRemaining
  } catch (e) {
    console.error("[workspace-ingest] recategorization pass failed (rows ingested fine):", e)
  }

  return { ok: true, alert: null, inserted, parsed: categorized.length, months, bankDetected, uncategorizedRemaining, sourceFileId }
}
