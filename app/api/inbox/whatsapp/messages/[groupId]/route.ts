import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

export const dynamic = "force-dynamic"

export async function GET(
  _req: NextRequest,
  { params }: { params: { groupId: string } }
) {
  const { groupId } = params

  if (!groupId) {
    return NextResponse.json({ error: "groupId is required" }, { status: 400 })
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("messages")
      .select(
        "id, content_text, direction, sender_name, sender_phone, created_at, content_type, media_url"
      )
      .eq("group_id", groupId)
      .order("created_at", { ascending: true })

    if (error) throw error

    return NextResponse.json({ messages: data ?? [] })
  } catch (error) {
    console.error("WhatsApp messages error:", error)
    return NextResponse.json(
      { error: "Failed to fetch WhatsApp messages" },
      { status: 500 }
    )
  }
}
