import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

export const dynamic = "force-dynamic"

/**
 * POST /api/inbox/whatsapp/send-mode   { mode?: "paused" | "shadow" | "live", allowlist?: string[], allowAll?: boolean }
 *
 * The pause switch for CRM replies on the self-hosted WhatsApp line — OWNER ONLY (Antonio's own login, isOwnerOnly).
 *  - paused : nothing can be queued or sent.        - shadow : replies are recorded but NEVER sent ("test mode").
 *  - live   : queued replies are sent by the Mac at the approved pace. Refused unless an allowlist exists (or allowAll is true).
 * `allowlist` replaces the list of numbers that may be messaged while live (digits; junk dropped). All rules live in the database functions.
 */
export async function POST(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!isOwnerOnly(user)) {
      return NextResponse.json({ error: "Only the owner can change whether WhatsApp replies are sent." }, { status: 403 })
    }

    const body = (await req.json().catch(() => ({}))) as { mode?: unknown; allowlist?: unknown; allowAll?: unknown }
    const wantsMode = body.mode !== undefined
    const wantsList = body.allowlist !== undefined
    if (!wantsMode && !wantsList) return NextResponse.json({ error: "Nothing to change." }, { status: 400 })
    if (wantsMode && body.mode !== "paused" && body.mode !== "shadow" && body.mode !== "live") {
      return NextResponse.json({ error: "Unknown mode." }, { status: 400 })
    }
    if (wantsList && (!Array.isArray(body.allowlist) || body.allowlist.length > 200 || body.allowlist.some((x) => typeof x !== "string"))) {
      return NextResponse.json({ error: "The list of numbers is not valid." }, { status: 400 })
    }

    const { data: channels, error: chErr } = await supabaseAdmin
      .from("messaging_channels")
      .select("id")
      .eq("platform", "whatsapp")
      .eq("provider", "wabridge")
      .eq("is_active", true)
    if (chErr) throw chErr
    if (!channels || channels.length !== 1) {
      return NextResponse.json({ error: "Could not tell which WhatsApp line to change." }, { status: 409 })
    }
    const channelId = channels[0].id

    if (wantsList) {
      const { data, error } = await supabaseAdmin.rpc("wabridge_set_send_allowlist", { p_channel_id: channelId, p_digits: body.allowlist as string[] })
      const r = data as { ok?: boolean; message?: string } | null
      if (error || !r || r.ok !== true) return NextResponse.json({ error: r?.message || "Could not save the list." }, { status: 409 })
    }
    if (wantsMode) {
      const { data, error } = await supabaseAdmin.rpc("wabridge_set_send_mode", {
        p_channel_id: channelId,
        p_mode: body.mode as string,
        p_allow_all: body.allowAll === true,
      })
      const r = data as { ok?: boolean; message?: string } | null
      if (error || !r || r.ok !== true) return NextResponse.json({ error: r?.message || "Could not change the mode." }, { status: 409 })
    }
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: "Could not save — please try again." }, { status: 500 })
  }
}
