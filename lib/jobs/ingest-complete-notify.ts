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
import { PORTAL_BASE_URL } from "@/lib/config"
import { localeFromLanguage } from "./wizard-failure-notify"

const SYSTEM_SENDER_ID = "00000000-0000-0000-0000-000000000000"

const MESSAGE: Record<"it" | "en", string> = {
  en: `Good news — we've finished reading your bank statements. You can now review your Profit & Loss and Balance Sheet in the portal: ${PORTAL_BASE_URL}/portal/tax-financials`,
  it: `Buone notizie — abbiamo finito di leggere i tuoi estratti conto. Ora puoi controllare il tuo Conto Economico e Stato Patrimoniale nel portale: ${PORTAL_BASE_URL}/portal/tax-financials`,
}

export interface IngestCompleteNotifyResult {
  notified: boolean
  reason?: string
}

/** Resolve the account's portal locale from its primary (or any) linked contact. */
async function resolveAccountLocale(accountId: string): Promise<"it" | "en"> {
  try {
    const { data: links } = await supabaseAdmin
      .from("account_contacts")
      .select("contact_id, is_primary")
      .eq("account_id", accountId)
    const rows = (links ?? []) as Array<{ contact_id: string | null; is_primary: boolean | null }>
    const chosen =
      rows.find((r) => r.is_primary && r.contact_id)?.contact_id ||
      rows.find((r) => r.contact_id)?.contact_id ||
      null
    if (chosen) {
      const { data } = await supabaseAdmin
        .from("contacts")
        .select("language")
        .eq("id", chosen)
        .maybeSingle()
      return localeFromLanguage(data?.language)
    }
  } catch {
    // fall through to default
  }
  return "en"
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
    // ── Last-job gate: any other ingest job for this account+year still in
    //    flight means more statements are coming — don't notify yet. tax_year is
    //    a JSON number in the payload → compare as text.
    const { data: others } = await supabaseAdmin
      .from("job_queue")
      .select("id, payload")
      .eq("job_type", "ingest_bank_statement")
      .eq("account_id", accountId)
      .in("status", ["pending", "processing"])
      .neq("id", selfJobId)
    const stillInFlight = ((others ?? []) as Array<{ payload: { tax_year?: number | string } | null }>)
      .some((j) => String(j.payload?.tax_year ?? "") === String(taxYear))
    if (stillInFlight) return { notified: false, reason: "more_pending" }

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

    const locale = await resolveAccountLocale(accountId)

    const { error } = await supabaseAdmin.from("portal_messages").insert({
      account_id: accountId,
      sender_type: "system",
      sender_id: SYSTEM_SENDER_ID,
      message: MESSAGE[locale],
    })
    if (error) {
      console.error(`[ingest-complete-notify] insert failed for account ${accountId} ${taxYear}:`, error.message)
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
