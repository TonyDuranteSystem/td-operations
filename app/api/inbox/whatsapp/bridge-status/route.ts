import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { classifyBridge, describeBridgeProblem, type BridgeProblem } from "@/lib/messaging/wabridge-health"
import { visibleLinkCode } from "@/lib/messaging/wabridge-link"

export const dynamic = "force-dynamic"

/**
 * GET /api/inbox/whatsapp/bridge-status
 *
 * Health of the self-hosted WhatsApp bridge for the Inbox banner (staff), plus — for the OWNER ONLY, only while the device
 * is unlinked and the code is fresh — the pairing code the Mac fetched, so Antonio can re-link from the CRM.
 * Health uses the same classifier as the alert email, so the banner and the email never disagree.
 * The response is never cached (it can carry a credential-equivalent code) and the code is never logged.
 */
export async function GET() {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const noStore = { "Cache-Control": "no-store" }
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const isOwner = isOwnerOnly(user)

    const { data: channels, error: chErr } = await supabaseAdmin
      .from("messaging_channels")
      .select("id")
      .eq("platform", "whatsapp")
      .eq("provider", "wabridge")
      .eq("is_active", true)
    if (chErr) throw chErr
    if (!channels?.length) return NextResponse.json({ health: "none", isOwner }, { headers: noStore })

    const ids = channels.map((c) => c.id)
    const { data: states, error: stErr } = await supabaseAdmin.from("wa_bridge_state").select("*").in("channel_id", ids)
    if (stErr) throw stErr

    const now = new Date()
    // A channel with no state row yet is simply not monitored. If several channels exist, report the worst one.
    let worst: { health: ReturnType<typeof classifyBridge>; state: (typeof states)[number] | null } = { health: "unmonitored", state: null }
    for (const id of ids) {
      const state = states?.find((s) => s.channel_id === id) ?? null
      const health = classifyBridge(state, now)
      if (health !== "ok" && health !== "unmonitored" && (worst.health === "ok" || worst.health === "unmonitored")) worst = { health, state }
      else if (worst.state === null && health === "ok") worst = { health, state }
    }

    const view = visibleLinkCode(
      { isOwner, health: worst.health, code: worst.state?.link_code, codeAt: worst.state?.link_code_at },
      now,
    )
    const text = worst.health !== "ok" && worst.health !== "unmonitored" ? describeBridgeProblem(worst.health as BridgeProblem) : null

    return NextResponse.json(
      {
        health: worst.health,
        isOwner,
        reason: text?.reason ?? null,
        hint: text?.hint ?? null,
        code: view.code,
        codeAgeSeconds: view.ageSeconds,
      },
      { headers: noStore },
    )
  } catch {
    // Deliberately no error detail: this route sits next to a credential-equivalent.
    return NextResponse.json({ error: "Could not read the WhatsApp link status." }, { status: 500, headers: noStore })
  }
}
