/**
 * POST /api/esign/envelopes/[id]/send — staff action.
 *
 * Enqueues signer-invite emails (durable job_queue). Sequential routing emails
 * only the first pending signer; parallel emails all pending signers with an
 * email. Marks the envelope `sent`. Returns counts (queued, skipped-no-email).
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { dispatchSignerDelivery } from "@/lib/esign/dispatch-delivery"
import { isTerminalEnvelopeStatus } from "@/lib/esign/envelope-status"
import { chooseLinkBase, originFromHeaders } from "@/lib/esign/link-base"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })

  const { id } = await params
  const { data: env } = await db
    .from("esign_envelopes")
    .select("id, status, routing_order")
    .eq("id", id)
    .maybeSingle()
  if (!env) return NextResponse.json({ error: "Envelope not found" }, { status: 404 })
  if (isTerminalEnvelopeStatus(env.status)) {
    return NextResponse.json({ error: `This envelope is ${env.status} and can't be sent.` }, { status: 400 })
  }

  const { data: signers } = await db
    .from("esign_signers")
    .select("id, email, contact_id, status, signer_index, signing_order")
    .eq("envelope_id", id)
    .order("signer_index")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = signers ?? []

  const base = chooseLinkBase(originFromHeaders(n => req.headers.get(n)), process.env.VERCEL_ENV === "production")

  // Deliver to pending signers; the channel (portal vs email) is resolved per
  // signer by the dispatcher. Sequential → only the first pending signer now;
  // parallel → all pending. The submit route hands off to the next on signing.
  const pending = all.filter(s => s.status === "pending")
  const targets = env.routing_order === "sequential" ? pending.slice(0, 1) : pending

  let emailed = 0
  let portal = 0
  let undeliverable = 0
  for (const s of targets) {
    const channel = await dispatchSignerDelivery({ signerId: s.id, baseUrl: base, createdBy: user?.email || "staff" })
    if (channel === "email") emailed++
    else if (channel === "portal") portal++
    else undeliverable++
  }

  if (env.status === "draft") {
    await db.from("esign_envelopes").update({ status: "sent", updated_at: new Date().toISOString() }).eq("id", id)
  }

  return NextResponse.json({ ok: true, emailed, portal, undeliverable })
}
