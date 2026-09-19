import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

export const dynamic = "force-dynamic"

/** Telegram counterpart of app/api/inbox/whatsapp/messages/[groupId] — same
 *  query shape (messages are stored identically regardless of platform);
 *  `sender_phone` is simply always null for a Telegram message. */
export async function GET(
  _req: NextRequest,
  { params }: { params: { groupId: string } }
) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const { groupId } = params
  if (!groupId) {
    return NextResponse.json({ error: "groupId is required" }, { status: 400 })
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("messages")
      .select("id, content_text, direction, sender_name, sender_phone, created_at, content_type, media_url")
      .eq("group_id", groupId)
      .order("created_at", { ascending: true })

    if (error) throw error

    return NextResponse.json({ messages: data ?? [] })
  } catch (error) {
    console.error("Telegram messages error:", error)
    return NextResponse.json({ error: "Failed to fetch Telegram messages" }, { status: 500 })
  }
}
