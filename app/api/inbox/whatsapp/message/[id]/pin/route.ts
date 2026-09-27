import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffUser } from "@/lib/auth"
import { NextRequest, NextResponse } from "next/server"

/**
 * POST /api/inbox/whatsapp/message/[id]/pin
 * Pin or unpin a WhatsApp message. Staff only — WhatsApp has no client-facing side to share this
 * with, unlike the portal chat pin (which both the client and staff can see/set). Body: { pinned: boolean }.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isStaffUser(user)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 })
  }

  const id = params.id
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  let body: { pinned?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const pinned = body.pinned === true

  const { data: msg, error: selErr } = await supabaseAdmin
    .from("messages")
    .select("id, deleted_at")
    .eq("id", id)
    .maybeSingle()
  if (selErr) return NextResponse.json({ error: selErr.message }, { status: 500 })
  if (!msg) return NextResponse.json({ error: "Message not found" }, { status: 404 })
  if (msg.deleted_at) return NextResponse.json({ error: "Cannot pin a hidden message" }, { status: 409 })

  const { error: updErr } = await supabaseAdmin
    .from("messages")
    .update({ pinned_at: pinned ? new Date().toISOString() : null })
    .eq("id", id)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({ ok: true, pinned })
}
