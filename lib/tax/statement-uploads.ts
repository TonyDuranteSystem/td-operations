/**
 * Statement upload lifecycle (Slice 7, master plan §6 + §7).
 *
 * Duplicate detection — three alert layers on top of the structural
 * guarantee (content-hash transaction_refs + the dedup unique index):
 *   L1 identical file  — SHA-256 match against an already-ingested file
 *   L2 row overlap     — how many of the new rows already exist (by ref)
 *   L3 period overlap  — same bank, overlapping months (informational)
 *
 * Delete & replace — rows are SOURCE-KEYED (`upload:<sha256>` for portal
 * CSVs, Drive file ids for staff ingestion), so deleting an upload removes
 * exactly its transactions. Drafts are computed, never stored, so deletion
 * needs no regeneration step. Post-confirm the submission is read-only
 * (isClientEditable) — deletion is refused.
 */

import { createHash } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isClientEditable, type ReviewStatus } from "./review-status"

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex")
}

/** W3 namespace: portal CSV uploads are source-keyed by content hash, never by
 *  storage path — the same file re-uploaded anywhere maps to the same source. */
export function uploadSourceId(sha256: string): string {
  return `upload:${sha256}`
}

export interface ExistingRow {
  transaction_ref: string
  transaction_date: string
  bank_name: string
  source_file_id: string | null
}

export interface NewUpload {
  sha256: string
  bankName: string
  refs: string[]
  /** ISO dates of the parsed rows. */
  dates: string[]
}

export interface DuplicateAnalysis {
  /** L1 — this exact file's rows are already in the system. */
  identicalFile: boolean
  /** L2 — refs in the new file that already exist (any source). */
  rowOverlap: { count: number; pct: number; months: string[] }
  /** L3 — months where this bank already has rows from other files. */
  periodOverlap: { months: string[] }
  /** Client-facing message when something needs attention; null = clean. */
  alert: string | null
}

const month = (isoDate: string) => isoDate.slice(0, 7)

/** Pure L1/L2/L3 analysis. Exported for tests. */
export function analyzeDuplicates(upload: NewUpload, existing: ExistingRow[]): DuplicateAnalysis {
  const sourceId = uploadSourceId(upload.sha256)
  const identicalFile = existing.some(r => r.source_file_id === sourceId)

  const existingRefs = new Set(existing.map(r => r.transaction_ref))
  const overlapping = upload.refs.filter(r => existingRefs.has(r))
  const overlapDates = new Set<string>()
  if (overlapping.length > 0) {
    const overlapSet = new Set(overlapping)
    const refToDate = new Map(upload.refs.map((r, i) => [r, upload.dates[i]]))
    for (const r of Array.from(overlapSet)) {
      const d = refToDate.get(r)
      if (d) overlapDates.add(month(d))
    }
  }
  const rowOverlap = {
    count: overlapping.length,
    pct: upload.refs.length > 0 ? Math.round((overlapping.length / upload.refs.length) * 100) : 0,
    months: Array.from(overlapDates).sort(),
  }

  const newMonths = new Set(upload.dates.map(month))
  const sameBankMonths = new Set(
    existing.filter(r => r.bank_name.toLowerCase() === upload.bankName.toLowerCase()).map(r => month(r.transaction_date)),
  )
  const periodOverlap = { months: Array.from(newMonths).filter(m => sameBankMonths.has(m)).sort() }

  let alert: string | null = null
  if (identicalFile) {
    alert = "Careful — you already uploaded this exact file. The information is already in the system; uploading it again will not duplicate anything, but you probably meant a different file."
  } else if (rowOverlap.count > 0) {
    alert = `Careful — ${rowOverlap.pct}% of this file's transactions (${rowOverlap.count}) are already in the system (${rowOverlap.months.join(", ")}). The duplicates are excluded automatically, so nothing is counted twice — but check that you exported the right period.`
  } else if (periodOverlap.months.length > 0) {
    alert = `Note: you already have ${upload.bankName} transactions for ${periodOverlap.months.join(", ")}. If this is a second account at the same bank, all good — the transactions are different. If it's the same account, check the export dates.`
  }

  return { identicalFile, rowOverlap, periodOverlap, alert }
}

/** Load the existing rows needed for analyzeDuplicates. */
export async function loadExistingRows(accountId: string, taxYear: number): Promise<ExistingRow[]> {
  const { data, error } = await supabaseAdmin
    .from("bank_transactions")
    .select("transaction_ref, transaction_date, bank_name, source_file_id")
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
  if (error) throw new Error(`Failed to load existing transactions: ${error.message}`)
  return (data ?? []) as ExistingRow[]
}

export interface DeleteResult {
  ok: boolean
  deleted: number
  error?: string
}

/**
 * Delete an upload's transactions (source-keyed cascade, §6). Refused after
 * the client confirmed (post-confirm lock) — staff must reopen first.
 */
export async function deleteStatementRows(accountId: string, taxYear: number, sourceFileId: string): Promise<DeleteResult> {
  const { data: sub } = await supabaseAdmin
    .from("tax_return_submissions")
    .select("review_status")
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const rs = (sub?.review_status ?? null) as ReviewStatus | null
  if (rs !== null && !isClientEditable(rs)) {
    return { ok: false, deleted: 0, error: "Your submission is locked (under review or already confirmed) — ask us to reopen it before changing files." }
  }

  const { data: deleted, error } = await supabaseAdmin
    .from("bank_transactions")
    .delete()
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
    .eq("source_file_id", sourceFileId)
    .select("id")
  if (error) return { ok: false, deleted: 0, error: error.message }
  return { ok: true, deleted: (deleted ?? []).length }
}
