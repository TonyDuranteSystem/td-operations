/**
 * Bank-statement ingestion complete → client "your statements are ready" notice.
 *
 * Why this exists:
 * MMLLC/Corp clients upload their bank statements through the tax wizard; each
 * file is read in the background by a per-file `ingest_bank_statement` job. A
 * busy account's full year of PDF statements takes ~30-45 min of AI extraction
 * (measured: CSV ~5s, PDF ~1-3min each). The client has no signal when their
 * Profit & Loss is finally ready to review — they either keep refreshing or
 * forget to come back. The financials page itself now shows a "still preparing"
 * state (dev_task b2115fd3), but that only helps a client who is sitting on the
 * page; this posts a one-time portal message so they know to return.
 *
 * Trigger: called from the ingest job handler after a file lands successfully.
 * It fires the notification ONLY when this is the LAST ingest job for the
 * account+year (no other pending/processing ingest jobs remain) — i.e. all
 * statements are in — and only ONCE per account+year (idempotency marker in
 * tax_return_submissions.financials_meta.ready_notified).
 *
 * Guardrails (mirrors lib/jobs/wizard-failure-notify.ts, verified 2026-06-26):
 * - sender_type='system' + zero-UUID sender_id (platform-authored portal_messages).
 * - sender_context left NULL (CHECK: NULL|'person'|'company').
 * - Never throws — a notification failure must never break the ingest job.
 * - Best-effort idempotency: a duplicate "ready" message on a simultaneous
 *   last-job race is harmless; a missed one is covered by the financials page's
 *   own "preparing" state. We do NOT block ingestion on any of this.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

// Locale resolution + message copy moved into the shared action-required
// dispatch (Phase C 2026-07-02) — the helper resolves per-recipient locale
// and appends the /portal/tax-financials deep link itself.

export interface IngestCompleteNotifyResult {
  notified: boolean
  reason?: string
}

/**
 * Post the one-time "statements ready" message if this `ingest_bank_statement`
 * job is the last one for its account+year. `selfJobId` is excluded from the
 * "remaining" count (it is still 'processing' while its own handler runs).
 * Safe to call after every ingest — self-gates and never throws.
 */
export async function notifyIfIngestComplete(params: {
  accountId: string
  taxYear: number
  selfJobId: string
}): Promise<IngestCompleteNotifyResult> {
  const { accountId, taxYear, selfJobId } = params
  try {
    // ── All-files gate (card 4a39e0fd — replaces the in-flight-only gate that
    //    produced the FALSE ALL-CLEAR): the "good news, we've finished reading
    //    your statements" message must consider every FILE, not just jobs
    //    still running. If any file for this account+year is failed or
    //    quarantined, saying "finished reading your bank statements" is a lie —
    //    an entire bank account may be missing from the books (the PAMAG
    //    shape: one file fails, a later file completes, client gets the happy
    //    message). Failed files have their own notification (failJob path), so
    //    withholding the all-clear never leaves the client in silence.
    const { data: jobRows } = await supabaseAdmin
      .from("job_queue")
      .select("id, status, result, payload")
      .eq("job_type", "ingest_bank_statement")
      .eq("account_id", accountId)
      .neq("status", "cancelled")
    const { computeIngestFileStates } = await import("@/lib/tax/ingest-file-status")
    // This job is still 'processing' while its own handler runs — count it as
    // the success it is (we are only called after a successful ingest), so a
    // prior failed attempt on the SAME path can't wedge the gate shut forever.
    const rows = ((jobRows ?? []) as Array<{ id: string; status: string; result: { ok?: boolean } | null; payload: { tax_year?: number | string; path?: string } | null }>)
      .map(j => (j.id === selfJobId ? { ...j, status: "completed", result: { ...(j.result ?? {}), ok: true } } : j))
    const states = computeIngestFileStates(rows, taxYear)
    const values = Array.from(states.values())
    if (values.some(s => s === "pending")) return { notified: false, reason: "more_pending" }
    if (values.some(s => s === "failed" || s === "quarantined")) {
      return { notified: false, reason: "failed_or_quarantined_files" }
    }

    // ── Target submission (carries the idempotency marker). No completed
    //    submission → nothing to attach to / the client has no review screen yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any // financials_meta not yet in database.types.ts
    const { data: sub } = await db
      .from("tax_return_submissions")
      .select("id, financials_meta")
      .eq("account_id", accountId)
      .eq("tax_year", taxYear)
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle() as { data: { id: string; financials_meta: Record<string, unknown> | null } | null }
    if (!sub?.id) return { notified: false, reason: "no_submission" }

    const meta = (sub.financials_meta ?? {}) as Record<string, unknown>
    if (meta.ready_notified === true) return { notified: false, reason: "already_notified" }

    // Phase C (2026-07-02): reviewing + attesting the P&L/BS is a CLIENT
    // ACTION, so this dispatches the full action-required package (clickable
    // chat + immediate email + bell/push) instead of the old chat-only system
    // message. Idempotency stays HERE (last-job gate + financials_meta marker)
    // — the helper's 10-minute dedup is not sufficient for re-uploads.
    const { notifyClientActionRequired } = await import("@/lib/portal/action-required")
    const dispatch = await notifyClientActionRequired({
      account_id: accountId,
      title: {
        en: `Review your Profit & Loss — ${taxYear}`,
        it: `Controlla il tuo Conto Economico — ${taxYear}`,
      },
      message: {
        en: "Good news — we've finished reading your bank statements. Please review your Profit & Loss and Balance Sheet in the portal and confirm them so we can move forward with your tax return.",
        it: "Buone notizie — abbiamo finito di leggere i tuoi estratti conto. Controlla il tuo Conto Economico e Stato Patrimoniale nel portale e confermali così possiamo procedere con la tua dichiarazione.",
      },
      link: "/portal/tax-financials",
    })
    if (dispatch.chat.startsWith("failed") && dispatch.notification.startsWith("failed")) {
      console.error(`[ingest-complete-notify] dispatch failed for account ${accountId} ${taxYear}:`, dispatch.chat)
      return { notified: false, reason: "insert_failed" }
    }

    // Best-effort marker so a later ingest (re-upload) doesn't re-announce.
    await db
      .from("tax_return_submissions")
      .update({ financials_meta: { ...meta, ready_notified: true } })
      .eq("id", sub.id)

    return { notified: true }
  } catch (e) {
    console.error(`[ingest-complete-notify] unexpected error for account ${accountId} ${taxYear}:`, e)
    return { notified: false, reason: "exception" }
  }
}
