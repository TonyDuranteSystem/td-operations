import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

export const dynamic = "force-dynamic"

/**
 * POST /api/inbox/whatsapp/bridge-request   body: { kind: "code" | "recover" }
 *
 * The two buttons of the WhatsApp link banner / toolbar. The CRM cannot call the Mac, so a press only leaves a request in the
 * database; the Mac reads it on its next heartbeat (about a minute) and answers through the receiver.
 *  - "code"    "Get a new code" — OWNER ONLY (the code is a credential-equivalent, same rule as showing it). Refused while the link is
 *              healthy, and past the 5-codes-per-hour limit (answered with when the hour is over).
 *  - "recover" "Recover missing messages" — any staff. Safe to press at any time: the Mac re-reads the phone's recent history and the
 *              CRM skips every message it already has.
 */
export async function POST(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const noStore = { "Cache-Control": "no-store" }
  const body = await req.json().catch(() => null)
  const kind = body && typeof body === "object" ? (body as Record<string, unknown>).kind : undefined
  if (kind !== "code" && kind !== "recover") {
    return NextResponse.json({ error: "Unknown request." }, { status: 400, headers: noStore })
  }

  try {
    if (kind === "code") {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!isOwnerOnly(user)) {
        return NextResponse.json({ error: "Only the owner can ask for a pairing code." }, { status: 403, headers: noStore })
      }
    }

    const { data: channels, error: chErr } = await supabaseAdmin
      .from("messaging_channels")
      .select("id")
      .eq("platform", "whatsapp")
      .eq("provider", "wabridge")
      .eq("is_active", true)
    if (chErr) throw chErr
    if (!channels?.length) return NextResponse.json({ error: "WhatsApp is not set up." }, { status: 404, headers: noStore })
    const channelId = channels[0].id

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabaseAdmin as any).rpc(kind === "code" ? "wabridge_request_link_code" : "wabridge_request_recover", { p_channel_id: channelId })
    if (error) throw error
    const result = data && typeof data === "object" ? (data as Record<string, unknown>) : {}
    return NextResponse.json({ ok: true, result: typeof result.result === "string" ? result.result : "unknown", retryAt: typeof result.retry_at === "string" ? result.retry_at : null }, { headers: noStore })
  } catch {
    return NextResponse.json({ error: "Could not send the request. Please try again." }, { status: 500, headers: noStore })
  }
}
