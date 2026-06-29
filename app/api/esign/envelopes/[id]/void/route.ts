/**
 * POST /api/esign/envelopes/[id]/void — staff action.
 *
 * Voids an in-flight envelope (draft / sent / in_progress) so it can no longer be
 * signed: flips status → 'voided' (a terminal status, enforced everywhere via
 * isTerminalEnvelopeStatus), records the reason + a 'voided' audit event. Already
 * terminal envelopes (voided/expired/completed/declined) are rejected. The
 * status flip is guarded (.in active statuses) so concurrent void/sign races
 * resolve to exactly one outcome.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isTerminalEnvelopeStatus } from "@/lib/esign/envelope-status"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })

  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : ""

  const { data: env } = await db.from("esign_envelopes").select("id, status").eq("id", id).maybeSingle()
  if (!env) return NextResponse.json({ error: "Envelope not found" }, { status: 404 })
  if (isTerminalEnvelopeStatus(env.status)) {
    return NextResponse.json({ error: `This envelope is already ${env.status} and can't be voided.` }, { status: 400 })
  }

  const now = new Date().toISOString()
  // Guarded transition: only void from an active status, so a concurrent
  // completion/decline/void can't be overwritten.
  const { data: updated } = await db
    .from("esign_envelopes")
    .update({ status: "voided", voided_at: now, void_reason: reason || null, updated_at: now })
    .eq("id", id)
    .in("status", ["draft", "sent", "in_progress"])
    .select("id")
    .maybeSingle()
  if (!updated) {
    return NextResponse.json({ error: "This envelope is no longer active and can't be voided." }, { status: 409 })
  }

  await db.from("esign_events").insert({
    envelope_id: id,
    event_type: "voided",
    metadata: { reason: reason || null, by: user?.email || "staff" },
  })

  return NextResponse.json({ ok: true, status: "voided" })
}
