import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

/**
 * POST /api/inbox/whatsapp/delete
 *
 * "Delete" for a WhatsApp conversation is a HIDE, not an erase — the same
 * recoverable shape as Gmail's own trash (R100-adjacent: this isn't
 * client-visible content, but destroying real message history on one click
 * with no undo is the same mistake either way). Every existing
 * `messaging_groups` row had `is_active = true` before this feature
 * (confirmed live before writing this route) and nothing else in the
 * codebase reads it, so it's repurposed here as the hide flag rather than
 * adding a second column: false = hidden from the Inbox list, true = shown.
 * The messages and the row itself are never touched.
 *
 * Body: { groupId, restore?: boolean } — restore:true undoes a delete.
 */
export async function POST(request: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const { groupId, restore } = await request.json() as { groupId?: string; restore?: boolean }
  if (!groupId) {
    return NextResponse.json({ error: "groupId is required" }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from("messaging_groups")
    .update({ is_active: Boolean(restore) })
    .eq("id", groupId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
