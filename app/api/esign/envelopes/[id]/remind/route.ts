/**
 * POST /api/esign/envelopes/[id]/remind — staff action.
 *
 * Nudges the signers who are still holding this document up, each through their
 * own channel (portal notification vs email). Active envelopes only.
 *
 * THROTTLE IS PER SIGNER, NOT PER ENVELOPE. A per-envelope throttle would let
 * one recently-nudged signer block the request and starve their co-signers of
 * the reminder entirely — so throttled signers are skipped and the rest are
 * delivered. 409 is reserved for "nobody here can be reminded right now", which
 * is the only case where the staff member needs to be told to wait.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isTerminalEnvelopeStatus } from "@/lib/esign/envelope-status"
import { chooseLinkBase, originFromHeaders } from "@/lib/esign/link-base"
import { REMINDER_SOURCE_MANUAL } from "@/lib/esign/events"
import { deliverReminder, loadReminderTimes } from "@/lib/esign/deliver-reminder"
import {
  selectReminderTargets,
  isManualReminderThrottled,
  MANUAL_REMINDER_COOLDOWN_HOURS,
} from "@/lib/esign/reminder-targeting"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })

  const { id } = await params
  const { data: env } = await db
    .from("esign_envelopes")
    .select("id, status, routing_order, document_name, owner_account_id")
    .eq("id", id)
    .maybeSingle()
  if (!env) return NextResponse.json({ error: "Envelope not found" }, { status: 404 })
  if (isTerminalEnvelopeStatus(env.status)) {
    return NextResponse.json(
      { error: `This document is ${String(env.status).replace("_", " ")} — there is nobody to remind.` },
      { status: 400 },
    )
  }
  if (env.status === "draft") {
    return NextResponse.json(
      { error: "This document hasn't been sent yet — use Send for signature instead." },
      { status: 400 },
    )
  }

  const { data: signers } = await db
    .from("esign_signers")
    .select("id, name, email, contact_id, delivery_channel, sent_at, status, signing_order")
    .eq("envelope_id", id)
    .order("signing_order", { ascending: true })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const targets = selectReminderTargets((signers ?? []) as any[], env.routing_order)

  if (!targets.length) {
    return NextResponse.json(
      { error: "Nobody is waiting to sign this document right now." },
      { status: 400 },
    )
  }

  // The link base must follow the CALLER's origin — a sandbox reminder that
  // mails a production link points at a deployment where the token doesn't exist.
  const base = chooseLinkBase(originFromHeaders(n => req.headers.get(n)), process.env.VERCEL_ENV === "production")
  const now = new Date()
  const times = await loadReminderTimes(targets.map(s => s.id))

  let emailed = 0
  let portal = 0
  let throttled = 0
  let undeliverable = 0

  for (const s of targets) {
    if (isManualReminderThrottled({ reminderTimes: times.get(s.id) ?? [], now })) {
      throttled++
      continue
    }
    const outcome = await deliverReminder({
      signer: s,
      envelope: { id: env.id, document_name: env.document_name, owner_account_id: env.owner_account_id },
      baseUrl: base,
      source: REMINDER_SOURCE_MANUAL,
      createdBy: user?.email || "staff",
    })
    if (outcome === "email") emailed++
    else if (outcome === "portal") portal++
    else undeliverable++
  }

  if (!emailed && !portal && throttled && !undeliverable) {
    return NextResponse.json(
      {
        error: `Already reminded in the last ${MANUAL_REMINDER_COOLDOWN_HOURS} hours — give them a bit before nudging again.`,
      },
      { status: 409 },
    )
  }

  return NextResponse.json({ ok: true, emailed, portal, throttled, undeliverable })
}
