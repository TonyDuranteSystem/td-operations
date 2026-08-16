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

export interface AttestationResetResult {
  /** True if an attestation and/or staff override actually existed and was cleared. */
  cleared: boolean
  /** Set only if the write failed — the attestation/override may still be standing. */
  error?: string
}

/**
 * Backward-compatible return value (round-3 bug-hunter pass): every existing
 * caller (answer/undo, statement delete/upload, balances, workspace-save)
 * fire-and-forgets this with a bare `await` and ignores the result — that
 * keeps working unchanged. A NEW caller that needs to know whether the
 * clear actually landed (reset-account-year.ts, which cannot silently
 * report "APPLIED" over a write that failed) can now check `.error`.
 */
export async function resetFinancialsAttestation(accountId: string, taxYear: number, reason: string): Promise<AttestationResetResult> {
  // The ONE submission resolver (card 4a39e0fd, architect blocker B3): the
  // old `.eq("status","completed")` filter missed `reviewed` submissions —
  // the exact stale rule resolve-submission.ts exists to kill. A mutation on
  // a reviewed+attested account-year left the client's sworn attestation
  // standing over numbers that had changed underneath it.
  const sub = await resolveClientSubmission<{
    id: string
    confirmation_accepted: boolean | null
    review_history: unknown
    financials_meta: Record<string, unknown> | null
  }>(supabaseAdmin, accountId, taxYear, "id, confirmation_accepted, review_history, financials_meta")
  if (!sub) return { cleared: false }

  const meta = (sub.financials_meta ?? {}) as Record<string, unknown>
  const hasOverride = meta.failed_files_override != null
  const attested = sub.confirmation_accepted === true
  if (!attested && !hasOverride) return { cleared: false } // nothing to reset

  const history = Array.isArray(sub.review_history) ? sub.review_history : []
  const now = new Date().toISOString()
  if (attested) {
    history.push({
      at: now,
      actor: "system",
      event: "financials_attestation_reset",
      note: `Attestation reset — the data changed after the client confirmed (${reason}). The client must confirm again.`,
    })
  }
  // The staff failed-files override (card 4a39e0fd unlock) covers a SPECIFIC
  // file set — any mutation invalidates that judgment, so it clears with the
  // attestation and staff must unlock again if the hole persists.
  if (hasOverride) {
    history.push({
      at: now,
      actor: "system",
      event: "failed_files_override_cleared",
      note: `Staff unlock cleared — the file set changed (${reason}).`,
    })
  }
  const updates: Record<string, unknown> = { review_history: history }
  if (attested) updates.confirmation_accepted = false
  if (hasOverride) {
    const { failed_files_override: _dropped, ...rest } = meta
    updates.financials_meta = rest
  }
  const { error } = await supabaseAdmin
    .from("tax_return_submissions")
    .update(updates)
    .eq("id", sub.id)
  if (error) {
    console.error(`[tax-financials] attestation reset failed: ${error.message}`)
    return { cleared: false, error: error.message }
  }
  return { cleared: true }
}
