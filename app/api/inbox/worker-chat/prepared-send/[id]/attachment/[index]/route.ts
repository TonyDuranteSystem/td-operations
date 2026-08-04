/**
 * GET /api/inbox/worker-chat/prepared-send/<prepared_id>/attachment/<index>
 *
 * Streams one attachment of a frozen draft so the staff member can OPEN the file
 * on the Confirm card before deciding — the card shows what is going out, not
 * just its name.
 *
 * Addressed by POSITION, never by storage path: the card carries an id and an
 * index, and this route resolves the location server-side. That matters most in
 * Team Chat, where the card is a permanent channel message — a signed URL baked
 * into that row would be either dead in hours (a broken tile living forever in
 * the scrollback) or a long-lived bearer link to a client document sitting in
 * chat history. Here, authorisation is re-checked on every single open.
 *
 * Staff-only, like every other /api/inbox route (the middleware session gate
 * covers the prefix; the explicit check below is the one that must hold if that
 * ever changes). Inline, private, never cached by a shared cache.
 */
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { WORKER_UPLOAD_BUCKET, isValidWorkerUploadPath } from "@/lib/ai-agent/attachment-reader"

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; index: string } },
) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const index = Number.parseInt(params.index, 10)
  if (!Number.isInteger(index) || index < 0) {
    return NextResponse.json({ error: "Bad attachment index" }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error } = await (supabaseAdmin as any)
    .from("worker_prepared_sends")
    .select("attachments")
    .eq("id", params.id)
    .maybeSingle()
  if (error || !row) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 })
  }

  // Deliberately NOT gated on status: a staff member looking at a card that was
  // just sent (or superseded) must still be able to see what left. Reading is
  // not sending, and hiding it after the fact only makes the record harder to
  // check.
  const list = (row.attachments ?? []) as Array<{ path?: string; name?: string; content_type?: string }>
  const att = list[index]
  if (!att?.path) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 })
  }
  // Every frozen attachment is materialised into the private bucket at prepare,
  // so this always holds. It is checked anyway: the value is read back out of a
  // jsonb column, and this is the gate that stops an arbitrary path reaching the
  // service-role client (which bypasses RLS).
  if (!isValidWorkerUploadPath(att.path)) {
    return NextResponse.json({ error: "Attachment not readable" }, { status: 404 })
  }

  const { data: file, error: dlErr } = await supabaseAdmin.storage.from(WORKER_UPLOAD_BUCKET).download(att.path)
  if (dlErr || !file) {
    return NextResponse.json({ error: "File no longer available" }, { status: 404 })
  }
  const bytes = Buffer.from(await file.arrayBuffer())

  // Quote-strip the filename: it reaches a header, and it can carry a client's
  // own naming (or an inbound file's) rather than ours.
  const filename = String(att.name ?? "file").replace(/["\r\n]/g, "")
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": att.content_type || file.type || "application/octet-stream",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  })
}
