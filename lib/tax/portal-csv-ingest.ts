/**
 * Portal CSV ingestion (Slice 7, master plan §3.3 + §7 + W3).
 *
 * The client-flow twin of the staff `bank_statement_process` tool: takes one
 * uploaded CSV, parses it by CONTENT SIGNATURE (never the client's bank
 * label), categorizes, dedup-checks (L1/L2/L3 alerts), inserts source-keyed
 * rows (`upload:<sha256>` — the same file maps to the same source on any
 * path, so re-ingestion collides harmlessly with the unique index), then runs
 * the deterministic categorization passes. The AI-assist pass is fired in the
 * background — the client gets instant feedback, AI refinement lands shortly
 * after.
 *
 * Every error message is a guide: what went wrong + exactly what to do.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { parseBankStatement, categorizeTransaction } from "@/lib/bank-statement-parser"
import { sha256Hex, uploadSourceId, analyzeDuplicates, loadExistingRows } from "./statement-uploads"
import { recategorizeAccountYear } from "./categorization-engine"
import { buildAccountRef } from "./bank-identity"

export interface IngestResult {
  ok: boolean
  /** Guide-grade message when the file could not be used. */
  error?: string
  /** Dedup alert (L1/L2/L3) — informational; insert proceeds unless identical file. */
  alert?: string | null
  inserted: number
  parsed: number
  /** Months covered (YYYY-MM, sorted) — drives the coverage question. */
  months: string[]
  /** Bank identified from file content (falls back to the client's label). */
  bankDetected: string
  uncategorizedRemaining: number
  sourceFileId: string
  /** Rows that error'd on insert (never dedup skips) — non-zero is already
   * error-audited; surfaced here so job steps/receipts can show it. */
  failed?: number
}

export interface IngestPortalCsvInput {
  accountId: string
  taxYear: number
  /** The client's free-text bank name — fallback identity only, never routing. */
  bankLabel: string
  /** checking | credit_card (from the wizard's per-bank section). */
  accountKind: string
  /** Client-provided account number/label for this file (account_number-mode
   *  institutions). Used to build the account identity; null for currency/crypto. */
  accountNumber?: string | null
  buffer: Buffer
  fileName: string
}

export async function ingestPortalCsv(input: IngestPortalCsvInput): Promise<IngestResult> {
  const { accountId, taxYear, bankLabel, accountNumber, buffer, fileName } = input
  const sha = sha256Hex(buffer)
  const sourceFileId = uploadSourceId(sha)
  const fail = (error: string): IngestResult => ({
    ok: false, error, inserted: 0, parsed: 0, months: [], bankDetected: bankLabel, uncategorizedRemaining: 0, sourceFileId,
  })

  // 0. Idempotency short-circuit. If this EXACT file content (source_file_id =
  //    hash of the bytes) already has rows for this account+year, it was already
  //    ingested — return success WITHOUT re-parsing. Critical because PDF
  //    AI-extraction is non-deterministic: a retry of an already-ingested file
  //    can return 0 transactions ("could not read") and would otherwise flip the
  //    file to FAILED even though its rows persist (source_file_id dedup) and are
  //    counted in the P&L — the "failed file whose data is actually in" bug.
  //    A genuinely new/edited file has different bytes → different source_file_id
  //    → no rows here → falls through to normal parsing.
  const { count: existingForSource } = await supabaseAdmin
    .from("bank_transactions")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
    .eq("source_file_id", sourceFileId)
  if ((existingForSource ?? 0) > 0) {
    return {
      ok: true,
      alert: `This file was already processed — ${existingForSource} transaction(s) are on file.`,
      inserted: 0, parsed: existingForSource ?? 0, months: [], bankDetected: bankLabel,
      uncategorizedRemaining: 0, sourceFileId,
    }
  }

  // 1. Parse by content signature. Route by the REAL file type so PDFs reach
  //    the AI extractor and CSVs hit the deterministic parsers — never force a
  //    single mime (the old hardcoded "text/csv" made every PDF parse as CSV →
  //    garbage → zero transactions). parseBankStatement also sniffs by file
  //    extension, but passing the correct mime keeps the routing explicit.
  const lower = fileName.toLowerCase()
  const mimeType = lower.endsWith(".pdf")
    ? "application/pdf"
    : lower.endsWith(".zip") || lower.endsWith(".x-zip-compressed")
      ? "application/zip"
      : "text/csv"
  const parsed = await parseBankStatement(buffer, fileName, mimeType, { taxYear })
  if (parsed.transactions.length === 0) {
    const detail = parsed.errors.length ? ` (${parsed.errors[0]})` : ""
    return fail(
      `We could not read any transactions from this file${detail}. ` +
      `Please upload each statement exactly as your bank exports it — a CSV or the official PDF for the full period. ` +
      `Do not merge, combine, or edit the files: tools like merge-csv.com change the format and make the file unreadable. ` +
      `Upload one file per bank account, just as the bank gives it to you.`,
    )
  }

  // 2. Categorize (legacy built-ins + member detection) and keep the tax year.
  const { data: links } = await supabaseAdmin
    .from("account_contacts")
    .select("contacts(first_name, last_name)")
    .eq("account_id", accountId)
  const memberNames = ((links ?? []) as unknown as Array<{ contacts: { first_name: string | null; last_name: string | null } | null }>)
    .filter(l => l.contacts)
    .map(l => `${l.contacts!.first_name ?? ""} ${l.contacts!.last_name ?? ""}`.trim())
    .filter(n => n.length > 0)

  const bankDetected = parsed.bank_name && parsed.bank_name !== "unknown" ? parsed.bank_name : bankLabel
  // Canonicalize the institution name and build the account identity ONCE per file
  // (one uploaded file = one account). Every row gets the canonical name + the
  // account_ref key so the account can never split on a name variant again.
  const ident = buildAccountRef({ rawBankName: bankDetected, accountNumber })
  const categorized = parsed.transactions
    .map(tx => categorizeTransaction(tx, memberNames, []))
    .filter(tx => tx.transaction_date.startsWith(String(taxYear)))
    .map(tx => ({ ...tx, bank_name: ident.canonical, account_ref: ident.account_ref }))

  if (categorized.length === 0) {
    return fail(
      `This file contains no ${taxYear} transactions (it covers a different period). ` +
      `Please export the entire year ${taxYear} — January 1 to December 31 — and upload that file.`,
    )
  }

  // 3. Duplicate analysis (L1/L2/L3) against what's already in the system.
  const existing = await loadExistingRows(accountId, taxYear)
  const analysis = analyzeDuplicates(
    { sha256: sha, bankName: ident.canonical, refs: categorized.map(t => t.transaction_ref), dates: categorized.map(t => t.transaction_date) },
    existing,
  )
  const months = Array.from(new Set(categorized.map(t => t.transaction_date.slice(0, 7)))).sort()
  if (analysis.identicalFile) {
    return { ok: true, alert: analysis.alert, inserted: 0, parsed: categorized.length, months, bankDetected, uncategorizedRemaining: 0, sourceFileId }
  }

  // 4. Insert — the unique index drops exact-duplicate rows (structural L2).
  // Per-row errors are COLLECTED and the whole file fails loudly when nothing
  // landed — a silent 0-insert hid the sandbox index drift for a full
  // submission (13 files parsed, 0 rows, no error anywhere).
  // S2 slice 1 (2026-07-08): PARTIAL drops are loud too — a constraint that
  // rejects a category (prod's CHECK lacked 'contribution', Dynamiq lost
  // $3,059.99 across 2 rows) used to fail only those rows with no trace beyond
  // the step text. Every error'd row now counts + reports to the error-audit
  // feed. Dedup skips are NOT errors (ignoreDuplicates returns no error).
  let inserted = 0
  let failedCount = 0
  let firstInsertError: string | null = null
  for (const tx of categorized) {
    const { error } = await supabaseAdmin
      .from("bank_transactions")
      .upsert({
        account_id: accountId,
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
      }, { onConflict: "account_id,transaction_ref,transaction_date,amount", ignoreDuplicates: true })
    if (!error) inserted++
    else {
      failedCount++
      if (!firstInsertError) firstInsertError = error.message
    }
  }
  if (inserted === 0 && categorized.length > 0 && firstInsertError) {
    return fail(`The file was read correctly (${categorized.length} transactions) but could not be saved: ${firstInsertError}. Please contact us — this is on our side, not yours.`)
  }
  if (failedCount > 0) {
    console.error(`[portal-csv-ingest] ${failedCount} row(s) FAILED to insert for account ${accountId} ${taxYear}: ${firstInsertError}`)
    try {
      const { reportSystemError } = await import("@/lib/system-errors")
      await reportSystemError({
        source: "server",
        route: "lib/tax/portal-csv-ingest",
        message: `Statement ingest dropped ${failedCount}/${categorized.length} row(s) for account ${accountId} ${taxYear}: ${firstInsertError}`,
        context: { account_id: accountId, tax_year: taxYear, source_file_id: sourceFileId, failed: failedCount, parsed: categorized.length },
      })
    } catch (e) {
      console.error("[portal-csv-ingest] error-audit report failed:", e)
    }
  }

  // 5. Deterministic categorization passes now (rules + transfer pairs)…
  let uncategorizedRemaining = 0
  try {
    const recat = await recategorizeAccountYear(accountId, taxYear)
    uncategorizedRemaining = recat.uncategorizedRemaining
  } catch (e) {
    console.error("[portal-csv-ingest] categorization pass failed (rows ingested fine):", e)
  }
  // …AI assist runs as a background JOB, NOT a dangling promise. A promise that
  // outlives the HTTP response gets the Vercel function torn down mid-flight —
  // the upload route then returned an empty 500 ("No response is returned from
  // route handler") to the client even though these rows were already ingested
  // (prod bug, 2026-06-26). Enqueue idempotently (at most one pending AI job per
  // account+year) so the worker runs it, fully awaited. Never blocks ingestion.
  try {
    const { supabaseAdmin: sb } = await import("@/lib/supabase-admin")
    const { data: existing } = await sb
      .from("job_queue")
      .select("id")
      .eq("job_type", "recategorize_ai")
      .eq("account_id", accountId)
      .eq("payload->>tax_year", String(taxYear))
      .in("status", ["pending", "processing"])
      .limit(1)
    if (!existing || existing.length === 0) {
      // DIRECT insert — NOT enqueueJobs(), which fires triggerWorker() as a
      // dangling fetch (await fetch(.../api/jobs/process) it does not await).
      // That promise + its 5s timeout keep the event loop alive past the HTTP
      // response, so Vercel tears the function down → "No response is returned
      // from route handler" → empty 500 to the client even though ingestion
      // succeeded (prod bug 2026-06-26, the second instance of this class).
      // The 5-min process-jobs cron drains this pending row; the AI pass is
      // advisory (ai_lean/ai_bucket hints) so a few minutes' delay is fine.
      await sb.from("job_queue").insert({
        job_type: "recategorize_ai",
        payload: { account_id: accountId, tax_year: taxYear },
        account_id: accountId,
        created_by: "portal_csv_ingest",
      } as never)
    }
  } catch (e) {
    console.error("[portal-csv-ingest] failed to enqueue AI categorization job:", e)
  }

  if (inserted > 0) {
    // The data changed — a prior attestation no longer covers it (QA finding).
    const { resetFinancialsAttestation } = await import("./attestation")
    await resetFinancialsAttestation(accountId, taxYear, `new file ingested (${inserted} transactions)`)
  }

  return { ok: true, alert: analysis.alert, inserted, parsed: categorized.length, months, bankDetected, uncategorizedRemaining, sourceFileId, failed: failedCount }
}
