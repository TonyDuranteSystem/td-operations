/**
 * In-flight ingestion check for an account + tax year.
 *
 * Used to gate the financials attestation: a client must not be able to confirm
 * their P&L / Balance Sheet while statement ingestion jobs are still running —
 * the numbers are still changing, and a premature attestation fires the handoff
 * (Excel archive + staff task) on incomplete data. The client UI already
 * disables the button while `ingestPending > 0`; this is the server-side guard
 * so the protection holds even if the button is bypassed or raced.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * How many `ingest_bank_statement` jobs for this account+year are still
 * pending or processing (i.e. statements still being read). Scoped to the year
 * via the JSONB payload (tax_year is stored as a JSON number → compare as text).
 */
export async function countInFlightIngestJobs(accountId: string, taxYear: number): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("job_queue")
    .select("payload")
    .eq("job_type", "ingest_bank_statement")
    .eq("account_id", accountId)
    .in("status", ["pending", "processing"])
  if (error) throw new Error(`countInFlightIngestJobs failed: ${error.message}`)
  return (data ?? []).filter(
    j => String((j.payload as { tax_year?: number | string } | null)?.tax_year ?? "") === String(taxYear),
  ).length
}

export interface IngestFileState {
  path: string
  succeeded: boolean
  pending: boolean
  failed: boolean
}

/**
 * Per-FILE ingest state for an account+year (S2 slice 3) — the aggregation the
 * portal GET used inline, extracted so the ATTEST route enforces the same
 * truth server-side. A file is DONE if ANY of its jobs completed successfully;
 * earlier failed/retried attempts for the same path are then irrelevant
 * ('cancelled' excluded — superseded enqueues are not failures).
 */
export async function listIngestFileStates(accountId: string, taxYear: number): Promise<IngestFileState[]> {
  const { data, error } = await supabaseAdmin
    .from("job_queue")
    .select("status, result, payload")
    .eq("job_type", "ingest_bank_statement")
    .eq("account_id", accountId)
    .in("status", ["pending", "processing", "failed", "completed"])
  if (error) throw new Error(`listIngestFileStates failed: ${error.message}`)
  const byPath = new Map<string, IngestFileState>()
  for (const j of (data ?? []) as Array<{ status: string; result: { ok?: boolean } | null; payload: { tax_year?: number | string; path?: string } | null }>) {
    if (String(j.payload?.tax_year ?? "") !== String(taxYear)) continue
    const path = j.payload?.path
    if (!path) continue
    const e = byPath.get(path) ?? { path, succeeded: false, pending: false, failed: false }
    if (j.status === "completed" && j.result?.ok !== false) e.succeeded = true
    else if (j.status === "pending" || j.status === "processing") e.pending = true
    else if (j.status === "failed" || (j.status === "completed" && j.result?.ok === false)) e.failed = true
    byPath.set(path, e)
  }
  return Array.from(byPath.values())
}

/** Files that FAILED with no successful attempt — the HARD confirm gate input. */
export function unresolvedFailedFiles(states: IngestFileState[]): IngestFileState[] {
  return states.filter(s => !s.succeeded && !s.pending && s.failed)
}
