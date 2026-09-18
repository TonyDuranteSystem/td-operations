import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

/**
 * POST /api/inbox/whatsapp/pin
 *
 * Gmail's Pin is a real Gmail star and silently no-ops for any non-Gmail
 * channel (conversation-list.tsx's pinMutation: `if (conv.channel !== 'gmail')
 * return`) — WhatsApp needed its own place to store this, added as
 * `messaging_groups.pinned` (migration 20260918-0800). Antonio, 2026-09-18.
 *
 * Body: { groupId, pinned: boolean }
 */
export async function POST(request: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const { groupId, pinned } = await request.json() as { groupId?: string; pinned?: boolean }
  if (!groupId || typeof pinned !== "boolean") {
    return NextResponse.json({ error: "groupId and pinned (boolean) are required" }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from("messaging_groups")
    .update({ pinned })
    .eq("id", groupId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
