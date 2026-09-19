import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

/** Telegram counterpart of app/api/inbox/whatsapp/mark-read — same logic,
 *  the read state is just messaging_groups.unread_count regardless of platform.
 *  Body: { groupId, unread: boolean } */
export async function POST(request: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const { groupId, unread } = await request.json() as { groupId?: string; unread?: boolean }
  if (!groupId || typeof unread !== "boolean") {
    return NextResponse.json({ error: "groupId and unread (boolean) are required" }, { status: 400 })
  }

  const { data: current } = await supabaseAdmin
    .from("messaging_groups")
    .select("unread_count")
    .eq("id", groupId)
    .single()

  const { error } = await supabaseAdmin
    .from("messaging_groups")
    .update({ unread_count: unread ? Math.max(current?.unread_count ?? 0, 1) : 0 })
    .eq("id", groupId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
