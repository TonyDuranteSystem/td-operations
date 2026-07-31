/**
 * E-Sign reminders + expiry — the core run by the cron. Pure of HTTP so it's
 * unit/live-testable with an injected `now` (time-travel).
 *
 * 1. Reconcile stuck completions.
 * 2. Expire non-terminal envelopes past their expires_at.
 * 3. Nudge invited-but-unsigned signers after a quiet period, capped (sequential
 *    → current signer only; parallel → all outstanding). Email signers go
 *    through the durable queue (no-op send in sandbox); PORTAL signers get a
 *    fresh portal notification.
 *
 * PORTAL SIGNERS USED TO BE SKIPPED ENTIRELY (2026-07-31 fix). The filter was
 * `.neq("delivery_channel", "portal")`, added because a portal signer must not
 * be emailed a direct signing link. Correct instinct, wrong remedy: most TD
 * clients sign inside the portal, so the effect was that automatic reminders
 * almost never fired for a real client — 3 people ever nudged in the tool's
 * whole history. They are now reminded THROUGH the portal instead of skipped.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { flattenEnvelopeToSignedPdf, finalizeEsignCompletion } from "@/lib/operations/esign"
import { insertEsignEvent, REMINDER_SOURCE_AUTO } from "@/lib/esign/events"
import { deliverReminder, loadReminderTimes, lastReopenedAt } from "@/lib/esign/deliver-reminder"
import {
  selectReminderTargets,
  shouldSendAutoReminder,
  remindersInCurrentCycle,
  REMINDER_AFTER_HOURS,
  MAX_REMINDERS,
} from "@/lib/esign/reminder-targeting"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

// Re-exported for the existing callers/tests that import them from here.
export { REMINDER_AFTER_HOURS, MAX_REMINDERS }

export async function runEsignReminders(now: Date = new Date()): Promise<{ expired: number; reminded: number; reconciled: number }> {
  // 0. Reconcile STUCK completions FIRST (before expiry, so a fully-signed-but-
  //    stuck envelope completes instead of being wrongly expired). If the last
  //    signer's flatten threw at submit time (60s cap on a big PDF, storage blip),
  //    the signer is signed + counted but the envelope never flipped to completed
  //    and the client never got the signed doc. Re-flatten + complete + finalize,
  //    idempotently (guarded status claim; retries next run if flatten still fails).
  let reconciled = 0
  const { data: maybeStuck } = await db
    .from("esign_envelopes")
    .select("id, signed_count, total_signers, signed_pdf_path")
    .in("status", ["sent", "in_progress"])
    .gt("signed_count", 0)
  for (const env of (maybeStuck ?? []) as Array<{ id: string; signed_count: number; total_signers: number; signed_pdf_path: string | null }>) {
    if ((env.signed_count ?? 0) < (env.total_signers ?? 1)) continue
    let signedPath = env.signed_pdf_path
    if (!signedPath) {
      try {
        signedPath = (await flattenEnvelopeToSignedPdf(env.id)).signedPath
      } catch {
        continue // transient — retry next run
      }
    }
    const { data: claimed } = await db
      .from("esign_envelopes")
      .update({ signed_pdf_path: signedPath, status: "completed", completed_at: now.toISOString(), updated_at: now.toISOString() })
      .eq("id", env.id)
      .in("status", ["sent", "in_progress"])
      .select("id")
      .maybeSingle()
    if (!claimed) continue
    await insertEsignEvent({ envelope_id: env.id, event_type: "completed", metadata: { signed_pdf_path: signedPath, via: "reconcile" } })
    await finalizeEsignCompletion(env.id)
    reconciled++
  }

  // 1. Expire overdue envelopes.
  const { data: expired } = await db
    .from("esign_envelopes")
    .update({ status: "expired", updated_at: now.toISOString() })
    .in("status", ["sent", "in_progress"])
    .not("expires_at", "is", null)
    .lt("expires_at", now.toISOString())
    .select("id")
  for (const e of (expired ?? []) as Array<{ id: string }>) {
    // insertEsignEvent, not a bare insert: this exact event was being rejected
    // by the CHECK constraint and silently discarded for over a month.
    await insertEsignEvent({ envelope_id: e.id, event_type: "expired", metadata: { reason: "expired" } })
  }

  // 3. Reminders — email AND portal signers.
  const { data: envs } = await db
    .from("esign_envelopes")
    .select("id, routing_order, document_name, owner_account_id")
    .in("status", ["sent", "in_progress"])
  let reminded = 0
  for (const env of (envs ?? []) as Array<{
    id: string
    routing_order: string
    document_name: string | null
    owner_account_id: string | null
  }>) {
    const { data: signers } = await db
      .from("esign_signers")
      .select("id, name, email, contact_id, delivery_channel, sent_at, status, signing_order")
      .eq("envelope_id", env.id)
      .order("signing_order", { ascending: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list: any[] = signers ?? []
    const candidates = selectReminderTargets(list, env.routing_order)
    if (!candidates.length) continue

    // A reopened envelope starts a fresh reminder cycle — otherwise the two
    // nudges it already spent keep it silent for its whole new window.
    const reopenedAt = await lastReopenedAt(env.id)
    const times = await loadReminderTimes(candidates.map(s => s.id))

    for (const s of candidates) {
      const cycle = remindersInCurrentCycle(times.get(s.id) ?? [], reopenedAt)
      if (!shouldSendAutoReminder({ sentAt: s.sent_at, reminderTimes: cycle, now })) continue
      const outcome = await deliverReminder({
        signer: s,
        envelope: { id: env.id, document_name: env.document_name, owner_account_id: env.owner_account_id },
        baseUrl: APP_BASE_URL,
        source: REMINDER_SOURCE_AUTO,
        createdBy: "cron",
      })
      if (outcome !== "undeliverable") reminded++
    }
  }

  return { expired: (expired ?? []).length, reminded, reconciled }
}
