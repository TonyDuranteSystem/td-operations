import { NextRequest, NextResponse } from "next/server"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

/**
 * POST /api/inbox/whatsapp/mark-read
 *
 * The Gmail row's mark-read/unread action (`/api/inbox/email-actions`) is
 * hardwired to Gmail thread ids and Gmail's read/unread label — it silently
 * does nothing for a WhatsApp row today, confirmed by reading the code
 * before building this (dev job f331cd43, Antonio 2026-09-18). A WhatsApp
 * conversation's read state is just `unread_count`; "mark read" zeroes it,
 * "mark unread" sets it to at least 1 so the badge reappears.
 *
 * Body: { groupId, unread: boolean }
 */
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
