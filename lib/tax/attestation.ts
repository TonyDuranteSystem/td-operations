/**
 * Financials attestation integrity (Slice 8 QA finding, 2026-06-11).
 *
 * The attestation ("I confirm the numbers are true") is only meaningful for
 * the data it was given on. Any mutation AFTER it — a new answer, a deleted
 * file, a new upload — makes the attested numbers stale, so the attestation
 * is RESET and the client re-confirms after their change. A history entry
 * records the reset; staff can always see the sequence.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export async function resetFinancialsAttestation(accountId: string, taxYear: number, reason: string): Promise<void> {
  const { data: sub } = await supabaseAdmin
    .from("tax_return_submissions")
    .select("id, confirmation_accepted, review_history")
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!sub || sub.confirmation_accepted !== true) return // nothing to reset

  const history = Array.isArray(sub.review_history) ? sub.review_history : []
  const entry = {
    at: new Date().toISOString(),
    actor: "system",
    event: "financials_attestation_reset",
    note: `Attestation reset — the data changed after the client confirmed (${reason}). The client must confirm again.`,
  }
  const { error } = await supabaseAdmin
    .from("tax_return_submissions")
    .update({ confirmation_accepted: false, review_history: [...history, entry] })
    .eq("id", sub.id)
  if (error) console.error(`[tax-financials] attestation reset failed: ${error.message}`)
}
