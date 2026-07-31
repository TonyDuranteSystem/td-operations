/**
 * POST /api/esign/envelopes/[id]/deadline — staff action.
 *
 * Change the deadline of a document that is ALREADY out with a client, to one
 * of the standard windows (7 / 14 / 30 days from now). Extend a document that
 * needs more time, or shorten one that needs chasing — without touching the
 * database by hand.
 *
 * THE CLIENT IS NOT NOTIFIED, in either direction (Antonio, 2026-07-31). The
 * deadline is visible in their portal anyway, and a message about an
 * administrative date change is noise.
 *
 * Silent to the client is NOT the same as unrecorded: the change writes a
 * `deadline_changed` audit event carrying who moved it, from what, to what. A
 * deadline decides when a signature stops being accepted — today's incident
 * (six live documents silently moved by a mis-scoped update, recoverable only
 * because their reopen had recorded the old value) is the argument for it.
 *
 * ACTIVE DOCUMENTS ONLY. An expired one has Reopen, which sets a fresh deadline
 * AND tells the client the document is live again — that is a different, louder
 * action and must not be reachable through this quiet one.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { insertEsignEvent } from "@/lib/esign/events"
import { normalizeExpiryDays } from "@/lib/esign/expiry"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** Statuses whose deadline still means anything. */
const CHANGEABLE = ["draft", "sent", "in_progress"]

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })

  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const days = normalizeExpiryDays(body?.days)

  const { data: env } = await db
    .from("esign_envelopes")
    .select("id, status, expires_at")
    .eq("id", id)
    .maybeSingle()
  if (!env) return NextResponse.json({ error: "Envelope not found" }, { status: 404 })

  if (!CHANGEABLE.includes(env.status)) {
    return NextResponse.json(
      {
        error:
          env.status === "expired"
            ? "This document has expired — use Reopen to give it a new deadline."
            : `This document is ${String(env.status).replace("_", " ")}, so its deadline no longer applies.`,
      },
      { status: 400 },
    )
  }

  const now = new Date()
  const newExpiry = new Date(now.getTime() + days * 86400000).toISOString()

  // Guarded on the status we read, so a document that completes, is declined or
  // expires in the same moment cannot have its deadline quietly rewritten.
  const { data: claimed } = await db
    .from("esign_envelopes")
    .update({ expires_at: newExpiry, updated_at: now.toISOString() })
    .eq("id", id)
    .in("status", CHANGEABLE)
    .select("id")
    .maybeSingle()
  if (!claimed) {
    return NextResponse.json(
      { error: "This document just changed status — reload the page and try again." },
      { status: 409 },
    )
  }

  await insertEsignEvent({
    envelope_id: id,
    event_type: "deadline_changed",
    metadata: {
      by: user?.email || "staff",
      days,
      from: env.expires_at ?? null,
      to: newExpiry,
    },
  })

  return NextResponse.json({ ok: true, expires_at: newExpiry, days })
}
