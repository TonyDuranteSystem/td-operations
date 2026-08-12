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
import { resolveClientSubmission } from "./resolve-submission"

export async function resetFinancialsAttestation(accountId: string, taxYear: number, reason: string): Promise<void> {
  // The ONE submission resolver (card 4a39e0fd, architect blocker B3): the
  // old `.eq("status","completed")` filter missed `reviewed` submissions —
  // the exact stale rule resolve-submission.ts exists to kill. A mutation on
  // a reviewed+attested account-year left the client's sworn attestation
  // standing over numbers that had changed underneath it.
  const sub = await resolveClientSubmission<{
    id: string
    confirmation_accepted: boolean | null
    review_history: unknown
  }>(supabaseAdmin, accountId, taxYear, "id, confirmation_accepted, review_history")
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
