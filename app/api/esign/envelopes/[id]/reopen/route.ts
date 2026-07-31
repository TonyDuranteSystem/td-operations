/**
 * POST /api/esign/envelopes/[id]/reopen — staff action.
 *
 * Puts an EXPIRED document back in flight with a fresh deadline, instead of
 * recreating and re-sending the whole thing. Signatures already collected, the
 * signer rows, and the signing links all survive (tokens are issued once at
 * creation and never rotated, and the signer routes gate on envelope STATUS,
 * not on the deadline — so restoring the status genuinely restores signability).
 *
 * Three things this route does that are not obvious:
 *
 * 1. STATUS AND DEADLINE MOVE IN ONE UPDATE, under a guard on `status =
 *    'expired'`. Two statements would leave a window where the envelope is
 *    active with a deadline still in the past, and the next expiry run (every
 *    6h) would simply re-expire it. The guard also resolves a race with that
 *    same cron and with a double-click.
 *
 * 2. IT NOTIFIES. "Reopen then press Send" does not work: Send is rendered only
 *    when a signer is still `pending`, and the send route only dispatches
 *    `pending` signers — on a reopened envelope every signer is `sent`/`viewed`,
 *    so Send is invisible and would be a no-op. Reopening silently would leave
 *    the client never told the document is live again.
 *
 * 3. IT FLAGS DUPLICATES. If the same document is already live on another
 *    envelope for this account, reopening puts two signable copies of one
 *    document in the client's portal, either of which can be signed and filed.
 *    The response reports them so staff can void the stale one.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { chooseLinkBase, originFromHeaders } from "@/lib/esign/link-base"
import { insertEsignEvent, REMINDER_SOURCE_MANUAL } from "@/lib/esign/events"
import { deliverReminder } from "@/lib/esign/deliver-reminder"
import { decideReopen, type ReopenDecision } from "@/lib/esign/reopen-eligibility"
import { selectReminderTargets } from "@/lib/esign/reminder-targeting"
import { DEFAULT_EXPIRY_DAYS } from "@/lib/esign/expiry"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })

  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const requestedDays = Number(body?.days)
  const days =
    Number.isFinite(requestedDays) && requestedDays >= 1 && requestedDays <= 365
      ? Math.floor(requestedDays)
      : DEFAULT_EXPIRY_DAYS

  const { data: env } = await db
    .from("esign_envelopes")
    .select("id, status, signed_count, total_signers, routing_order, document_name, owner_account_id")
    .eq("id", id)
    .maybeSingle()
  if (!env) return NextResponse.json({ error: "Envelope not found" }, { status: 404 })

  const { data: signers } = await db
    .from("esign_signers")
    .select("id, name, email, contact_id, delivery_channel, sent_at, status, signing_order")
    .eq("envelope_id", id)
    .order("signing_order", { ascending: true })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signerRows: any[] = signers ?? []

  const decision: ReopenDecision = decideReopen({
    status: env.status,
    signed_count: env.signed_count ?? 0,
    total_signers: env.total_signers ?? signerRows.length,
    signers: signerRows,
  })
  if (decision.kind === "refused") {
    return NextResponse.json({ error: decision.message, reason: decision.reason }, { status: 400 })
  }

  const now = new Date()
  const newExpiry = new Date(now.getTime() + days * 86400000).toISOString()

  // Guarded, single-statement transition — see note 1 in the header.
  const { data: claimed } = await db
    .from("esign_envelopes")
    .update({
      status: decision.nextStatus,
      expires_at: newExpiry,
      updated_at: now.toISOString(),
    })
    .eq("id", id)
    .eq("status", "expired")
    .select("id")
    .maybeSingle()
  if (!claimed) {
    return NextResponse.json(
      { error: "This document is no longer expired — someone may have just reopened or voided it." },
      { status: 409 },
    )
  }

  await insertEsignEvent({
    envelope_id: id,
    event_type: "reopened",
    metadata: { by: user?.email || "staff", new_expires_at: newExpiry, days },
  })

  // Re-notify whoever still has to sign (see note 2). Tagged as a manual
  // reminder because a person chose to do this; the fresh cycle is anchored on
  // the `reopened` event above, so automatic follow-ups resume from here.
  const base = chooseLinkBase(originFromHeaders(n => req.headers.get(n)), process.env.VERCEL_ENV === "production")
  const targets = selectReminderTargets(signerRows, env.routing_order)
  let emailed = 0
  let portal = 0
  let undeliverable = 0
  for (const s of targets) {
    const outcome = await deliverReminder({
      signer: s,
      envelope: { id: env.id, document_name: env.document_name, owner_account_id: env.owner_account_id },
      baseUrl: base,
      source: REMINDER_SOURCE_MANUAL,
      createdBy: user?.email || "staff",
      // The chat message says "we've reopened it", not "still waiting" — the
      // client's last signal was that the document had lapsed.
      nudgeKind: "reopened",
    })
    if (outcome === "email") emailed++
    else if (outcome === "portal") portal++
    else undeliverable++
  }

  // Duplicate check (see note 3) — advisory, never blocks the reopen.
  let duplicates: Array<{ id: string; document_name: string }> = []
  if (env.owner_account_id && env.document_name) {
    const { data: dupes } = await db
      .from("esign_envelopes")
      .select("id, document_name")
      .eq("owner_account_id", env.owner_account_id)
      .eq("document_name", env.document_name)
      .in("status", ["sent", "in_progress"])
      .neq("id", id)
    duplicates = (dupes ?? []) as Array<{ id: string; document_name: string }>
  }

  return NextResponse.json({
    ok: true,
    status: decision.nextStatus,
    expires_at: newExpiry,
    emailed,
    portal,
    undeliverable,
    duplicates,
  })
}
