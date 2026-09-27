import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createClient } from "@/lib/supabase/server"
import { isStaffUser } from "@/lib/auth"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/inbox/whatsapp/outbox/resolve   { outboxId, action: "sent" | "discard" }
 *
 * A person's decision on a WhatsApp reply the Mac could not confirm ("Not confirmed — check the phone"). They looked at the phone:
 *  - "sent"    → the message did go out; the CRM records it in the chat.
 *  - "discard" → it did not go out; the CRM drops it. It is NEVER retried automatically.
 * Refused while the message is still being sent (under 2 minutes), and for anything that is not waiting for a decision.
 * Staff only (a client or partner login is refused — requireStaffRoute alone lets a partner through).
 */
export async function POST(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!isStaffUser(user)) {
      return NextResponse.json({ error: "Only the TD team can do this." }, { status: 403 })
    }

    const body = (await req.json().catch(() => ({}))) as { outboxId?: unknown; action?: unknown }
    if (typeof body.outboxId !== "string" || !UUID_RE.test(body.outboxId) || (body.action !== "sent" && body.action !== "discard")) {
      return NextResponse.json({ error: "Missing or invalid request." }, { status: 400 })
    }

    const { data, error } = await supabaseAdmin.rpc("wabridge_resolve_outbox", {
      p_outbox_id: body.outboxId,
      p_action: body.action,
      p_user: user?.id ?? null,
    })
    if (error || typeof data !== "object" || data === null) {
      return NextResponse.json({ error: "Could not save your decision — please try again." }, { status: 500 })
    }
    const result = data as { ok?: boolean; message?: string; status?: string }
    if (result.ok !== true) {
      return NextResponse.json({ error: result.message || "That message cannot be changed right now." }, { status: 409 })
    }
    return NextResponse.json({ success: true, status: result.status })
  } catch {
    return NextResponse.json({ error: "Could not save your decision — please try again." }, { status: 500 })
  }
}
