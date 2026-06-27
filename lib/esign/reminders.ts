/**
 * E-Sign reminders + expiry — the core run by the cron. Pure of HTTP so it's
 * unit/live-testable with an injected `now` (time-travel).
 *
 * 1. Expire non-terminal envelopes past their expires_at.
 * 2. Nudge invited-but-unsigned signers after a quiet period, capped (sequential
 *    → current signer only; parallel → all pending). Reminders go through the
 *    durable queue (no-op send in sandbox).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { enqueueJob } from "@/lib/jobs/queue"
import { APP_BASE_URL } from "@/lib/config"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export const REMINDER_AFTER_HOURS = 48
export const MAX_REMINDERS = 2

export async function runEsignReminders(now: Date = new Date()): Promise<{ expired: number; reminded: number }> {
  // 1. Expire overdue envelopes.
  const { data: expired } = await db
    .from("esign_envelopes")
    .update({ status: "expired", updated_at: now.toISOString() })
    .in("status", ["sent", "in_progress"])
    .not("expires_at", "is", null)
    .lt("expires_at", now.toISOString())
    .select("id")
  for (const e of (expired ?? []) as Array<{ id: string }>) {
    await db.from("esign_events").insert({ envelope_id: e.id, event_type: "voided", metadata: { reason: "expired" } })
  }

  // 2. Reminders.
  const cutoff = new Date(now.getTime() - REMINDER_AFTER_HOURS * 3600 * 1000)
  const { data: envs } = await db
    .from("esign_envelopes")
    .select("id, routing_order")
    .in("status", ["sent", "in_progress"])
  let reminded = 0
  for (const env of (envs ?? []) as Array<{ id: string; routing_order: string }>) {
    const { data: signers } = await db
      .from("esign_signers")
      .select("id, email, sent_at, signing_order")
      .eq("envelope_id", env.id)
      .in("status", ["sent", "viewed"])
      .order("signing_order", { ascending: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list: any[] = signers ?? []
    const candidates = env.routing_order === "sequential" ? list.slice(0, 1) : list
    for (const s of candidates) {
      if (!s.email || !s.sent_at) continue
      const { data: rems } = await db
        .from("esign_events")
        .select("created_at")
        .eq("signer_id", s.id)
        .eq("event_type", "reminder_sent")
        .order("created_at", { ascending: false })
      const remList = (rems ?? []) as Array<{ created_at: string }>
      if (remList.length >= MAX_REMINDERS) continue
      const lastTouch = remList.length ? new Date(remList[0].created_at) : new Date(s.sent_at)
      if (lastTouch > cutoff) continue
      await enqueueJob({
        job_type: "esign_send_email",
        payload: { signer_id: s.id, base_url: APP_BASE_URL, reminder: true },
        related_entity_type: "esign_envelope",
        related_entity_id: env.id,
      })
      reminded++
    }
  }

  return { expired: (expired ?? []).length, reminded }
}
