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
