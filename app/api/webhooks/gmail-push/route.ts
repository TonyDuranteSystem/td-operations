import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { INTERNAL_BASE_URL } from "@/lib/config"

// gmail_push_events / gmail_watch_state are not in the generated Database
// types yet (regenerated from production after the prod DDL). Same escape
// hatch as lib/system-errors.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any
import {
  mailboxForAddress,
  parsePushMessage,
  verifyPushOidc,
} from "@/lib/gmail-push"

export const dynamic = "force-dynamic"

/**
 * POST /api/webhooks/gmail-push — Pub/Sub push endpoint for Gmail watch.
 *
 * Auth: Google-signed OIDC token (subscription is configured to mint one as
 * our service account with this URL as audience) — verified, fails closed.
 * Registered on PRODUCTION only; sandbox blocks /api/webhooks/* entirely.
 *
 * Response contract (Pub/Sub semantics):
 *  - 2xx  → acked (also for notifications we deliberately ignore)
 *  - 401  → rejected (bad/missing token)
 *  - 5xx  → Pub/Sub retries (transient DB failure)
 */
export async function POST(req: NextRequest) {
  const audience = `${INTERNAL_BASE_URL}/api/webhooks/gmail-push`
  const authorized = await verifyPushOidc(req.headers.get("authorization"), audience)
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: true, ignored: "unparseable" })
  }

  const notification = parsePushMessage(body)
  if (!notification) {
    return NextResponse.json({ ok: true, ignored: "no gmail payload" })
  }

  const mailbox = mailboxForAddress(notification.emailAddress)
  if (!mailbox) {
    return NextResponse.json({ ok: true, ignored: "unknown mailbox" })
  }

  const { error } = await db.from("gmail_push_events").insert({
    mailbox,
    email_address: notification.emailAddress.toLowerCase(),
    history_id: notification.historyId,
  })
  if (error) {
    console.error("[gmail-push] insert failed:", error.message)
    return NextResponse.json({ error: "storage failed" }, { status: 500 })
  }

  // Keep watch state fresh (best-effort)
  await db
    .from("gmail_watch_state")
    .update({ history_id: notification.historyId, updated_at: new Date().toISOString() })
    .eq("mailbox", mailbox)

  // Email index: incremental sync of whatever changed (best-effort — the
  // email-index-sync cron reconciles anything a push misses)
  try {
    const { syncIncremental } = await import("@/lib/email-index/sync")
    await syncIncremental(mailbox as "support" | "antonio", notification.historyId)
  } catch (err) {
    console.warn("[gmail-push] incremental index sync failed (cron will heal):", err)
  }

  // Content capture: grab the new message BODIES + attachments right now, so an
  // email is in our own store seconds after it lands instead of waiting for the
  // */10 capture cron (Antonio 2026-08-03: "make it push"). Best-effort and
  // deliberately tiny (a push means a handful of new messages) — the cron stays
  // as the safety net for anything a push misses, and insert-once means this
  // never re-downloads what is already stored.
  try {
    const { captureBatchLive } = await import("@/lib/email-store/worker")
    await captureBatchLive(mailbox as "support" | "antonio", 10, 1)
  } catch (err) {
    console.warn("[gmail-push] instant content capture failed (cron will heal):", err)
  }

  return NextResponse.json({ ok: true })
}
