/**
 * Staff unlock of the failed-statement-file HARD BLOCK on the client's
 * tax-financials confirmation (card 4a39e0fd, Antonio's binding ruling
 * 2026-08-12): staff-only, reason REQUIRED, logged, and the client gets a
 * portal chat message. ONE core shared by the CRM admin route and the
 * Exception Center action — the override flag it writes is exactly what the
 * attest route reads, and any later file mutation clears it (attestation.ts).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export interface UnlockResult {
  ok: boolean
  error?: string
}

export async function unlockFinancialsConfirm(params: {
  accountId: string
  taxYear: number
  reason: string
  actor: string
}): Promise<UnlockResult> {
  const { accountId, taxYear, actor } = params
  const reason = params.reason.trim()
  if (reason.length < 10) {
    return { ok: false, error: "A reason is required (at least 10 characters) — it is shown in the audit log." }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any // financials_meta not yet in database.types.ts
  const { resolveClientSubmission } = await import("./resolve-submission")
  const sub = await resolveClientSubmission<{ id: string; financials_meta: Record<string, unknown> | null; review_history: unknown }>(
    db, accountId, taxYear, "id, financials_meta, review_history",
  )
  if (!sub) return { ok: false, error: "No submission found for this account and year." }

  const at = new Date().toISOString()
  const meta = (sub.financials_meta ?? {}) as Record<string, unknown>
  const history = Array.isArray(sub.review_history) ? sub.review_history : []
  history.push({
    at,
    actor,
    event: "failed_files_override",
    note: `Staff unlocked the client's Confirm despite unprocessed statement file(s). Reason: ${reason}`,
  })

  const { error } = await db
    .from("tax_return_submissions")
    .update({
      financials_meta: { ...meta, failed_files_override: { by: actor, reason, at } },
      review_history: history,
    })
    .eq("id", sub.id)
  if (error) return { ok: false, error: error.message }

  try {
    const { logAction } = await import("@/lib/mcp/action-log")
    logAction({
      action_type: "financials_confirm_unlock",
      table_name: "tax_return_submissions",
      record_id: sub.id,
      summary: `Unlocked tax-financials Confirm for account ${accountId} (${taxYear}) despite unprocessed statement file(s). Reason: ${reason}`,
      details: { account_id: accountId, tax_year: taxYear, by: actor },
    })
  } catch (e) {
    console.error("[confirm-unlock] action_log failed (unlock saved):", e)
  }

  // Client-visible chat note (ruling d) — never silent.
  try {
    const { emitClientChatEvent } = await import("@/lib/portal/chat-events")
    await emitClientChatEvent({
      contact_id: null,
      account_id: accountId,
      topic: "tax_review",
      message:
        "Our team reviewed the statement file that could not be processed and has unlocked your confirmation — you can now review and confirm your Profit & Loss.",
      source: { table: "tax_return_submissions", id: sub.id },
      event_kind: "financials_confirm_unlocked",
    })
  } catch (e) {
    console.error("[confirm-unlock] client notice failed (unlock saved):", e)
  }

  return { ok: true }
}
