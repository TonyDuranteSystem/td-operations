import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffUser } from "@/lib/auth"
import { NextRequest, NextResponse } from "next/server"

/**
 * DELETE /api/inbox/whatsapp/message/[id]
 * Hide a WhatsApp message from OUR OWN screen only (soft-delete, same R100 shape as the portal chat
 * delete — a kept audit row, filtered out of the default list). Deliberately NOT called "delete" in
 * the UI label: the real message on WhatsApp, on the person's own phone, is completely untouched —
 * we have no way to recall or unsend it from here. This only removes our own copy from view.
 * Staff only.
 */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isStaffUser(user)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 })
  }

  const id = params.id
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  const { data: existing, error: selectError } = await supabaseAdmin
    .from("messages")
    .select("id, deleted_at")
    .eq("id", id)
    .maybeSingle()
  if (selectError) return NextResponse.json({ error: selectError.message }, { status: 500 })
  if (!existing) return NextResponse.json({ error: "Message not found" }, { status: 404 })
  if (existing.deleted_at) return NextResponse.json({ error: "Already hidden" }, { status: 409 })

  const { error: updateError } = await supabaseAdmin
    .from("messages")
    .update({ deleted_at: new Date().toISOString(), deleted_by: user.id })
    .eq("id", id)
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
