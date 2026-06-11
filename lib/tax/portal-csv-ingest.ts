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
}

export interface IngestPortalCsvInput {
  accountId: string
  taxYear: number
  /** The client's free-text bank name — fallback identity only, never routing. */
  bankLabel: string
  /** checking | credit_card (from the wizard's per-bank section). */
  accountKind: string
  buffer: Buffer
  fileName: string
}

export async function ingestPortalCsv(input: IngestPortalCsvInput): Promise<IngestResult> {
  const { accountId, taxYear, bankLabel, buffer, fileName } = input
  const sha = sha256Hex(buffer)
  const sourceFileId = uploadSourceId(sha)
  const fail = (error: string): IngestResult => ({
    ok: false, error, inserted: 0, parsed: 0, months: [], bankDetected: bankLabel, uncategorizedRemaining: 0, sourceFileId,
  })

  // 1. Parse by content signature (unknown layouts go to the AI extractor inside).
  const parsed = await parseBankStatement(buffer, fileName, "text/csv", { taxYear })
  if (parsed.transactions.length === 0) {
    const detail = parsed.errors.length ? ` (${parsed.errors[0]})` : ""
    return fail(
      `We could not read any transactions from this file${detail}. ` +
      `Please export the CSV directly from your online banking — open the account, choose Export/Download, set the dates to the entire year, and pick CSV. Do not edit or re-save the file before uploading.`,
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
  const categorized = parsed.transactions
    .map(tx => categorizeTransaction(tx, memberNames, []))
    .filter(tx => tx.transaction_date.startsWith(String(taxYear)))
    .map(tx => ({ ...tx, bank_name: tx.bank_name && tx.bank_name !== "unknown" ? tx.bank_name : bankDetected }))

  if (categorized.length === 0) {
    return fail(
      `This file contains no ${taxYear} transactions (it covers a different period). ` +
      `Please export the entire year ${taxYear} — January 1 to December 31 — and upload that file.`,
    )
  }

  // 3. Duplicate analysis (L1/L2/L3) against what's already in the system.
  const existing = await loadExistingRows(accountId, taxYear)
  const analysis = analyzeDuplicates(
    { sha256: sha, bankName: bankDetected, refs: categorized.map(t => t.transaction_ref), dates: categorized.map(t => t.transaction_date) },
    existing,
  )
  const months = Array.from(new Set(categorized.map(t => t.transaction_date.slice(0, 7)))).sort()
  if (analysis.identicalFile) {
    return { ok: true, alert: analysis.alert, inserted: 0, parsed: categorized.length, months, bankDetected, uncategorizedRemaining: 0, sourceFileId }
  }

  // 4. Insert — the unique index drops exact-duplicate rows (structural L2).
  let inserted = 0
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
        transaction_ref: tx.transaction_ref,
        source_file_id: sourceFileId,
        is_related_party: tx.is_related_party,
        notes: tx.notes,
      }, { onConflict: "account_id,transaction_ref,transaction_date,amount", ignoreDuplicates: true })
    if (!error) inserted++
  }

  // 5. Deterministic categorization passes now (rules + transfer pairs)…
  let uncategorizedRemaining = 0
  try {
    const recat = await recategorizeAccountYear(accountId, taxYear)
    uncategorizedRemaining = recat.uncategorizedRemaining
  } catch (e) {
    console.error("[portal-csv-ingest] categorization pass failed (rows ingested fine):", e)
  }
  // …AI assist in the background — instant feedback for the client, AI lands after.
  void recategorizeAccountYear(accountId, taxYear, { aiAssist: true })
    .catch(e => console.error("[portal-csv-ingest] AI categorization pass failed:", e))

  return { ok: true, alert: analysis.alert, inserted, parsed: categorized.length, months, bankDetected, uncategorizedRemaining, sourceFileId }
}
