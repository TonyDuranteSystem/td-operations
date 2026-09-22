import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { CRM_STORAGE_BUCKET } from "@/lib/crm-storage/constants"
import { CHAT_SHARE_MAX_BYTES, CHAT_SHARE_MAX_MB } from "@/lib/crm-storage/share-limits"
import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/**
 * POST /api/crm-storage/files/[id]/share-team-chat
 *
 * Sends an existing CRM Storage file into a Team Chat thread as a real
 * attachment. Modeled on the proven app/api/captures/[id]/share-team-chat
 * route (same copy-then-deliver-through-the-real-send-route shape, same
 * reason for NOT using lib/team/post-message.ts's postTeamMessage() — that
 * always stamps the CLAUDE sentinel identity, and a person sharing their own
 * file must show up as themselves). See lib/crm-storage/share-actions.ts for
 * why this route has no "already shared" claim/resend concept: a stored
 * document is a reusable library item, not a one-shot capture.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const { id: fileId } = await params

  const body = await request.json().catch(() => ({}))
  const threadId = typeof body.thread_id === "string" ? body.thread_id : ""
  if (!threadId) return NextResponse.json({ error: "Which conversation?" }, { status: 400 })

  const { data: file, error: fileErr } = await db
    .from("crm_storage_files")
    .select("id, file_name, mime_type, file_size, storage_bucket, storage_path")
    .eq("id", fileId)
    .is("deleted_at", null)
    .maybeSingle()
  if (fileErr || !file) return NextResponse.json({ error: "That file is gone. Please try again." }, { status: 404 })
  if (file.file_size != null && Number(file.file_size) > CHAT_SHARE_MAX_BYTES) {
    return NextResponse.json({ error: `That file is too large for chat. Maximum: ${CHAT_SHARE_MAX_MB} MB.` }, { status: 400 })
  }

  const { data: thread } = await db.from("internal_threads").select("id").eq("id", threadId).single()
  if (!thread) return NextResponse.json({ error: "That conversation is gone. Please try again." }, { status: 404 })

  // Copy: download from the private crm-files bucket, upload into the
  // public `assets` bucket team chat already uses — same shape as the
  // captures route's own cross-bucket copy.
  const { data: blob, error: dlErr } = await db.storage.from(file.storage_bucket || CRM_STORAGE_BUCKET).download(file.storage_path)
  if (dlErr || !blob) {
    console.error("[crm-storage/share-team-chat] download error:", dlErr)
    return NextResponse.json({ error: "Could not read the file. Please try again." }, { status: 500 })
  }
  const buffer = Buffer.from(await blob.arrayBuffer())
  const ext = (file.file_name?.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
  const assetsPath = `team-chat/${threadId}/${randomUUID()}.${ext}`
  const { error: upErr } = await db.storage
    .from("assets")
    .upload(assetsPath, buffer, { contentType: file.mime_type || "application/octet-stream", upsert: false })
  if (upErr) {
    console.error("[crm-storage/share-team-chat] upload error:", upErr)
    return NextResponse.json({ error: "Could not share the file. Please try again." }, { status: 500 })
  }
  const { data: urlData } = db.storage.from("assets").getPublicUrl(assetsPath)

  // Deliver through the real human send route — same identity, push, and
  // mention handling every other team-chat message already gets.
  let sendRes: Response
  try {
    sendRes = await fetch(`${request.nextUrl.origin}/api/team/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: request.headers.get("cookie") || "" },
      body: JSON.stringify({
        message: `Shared a file: ${file.file_name}`,
        attachments: [
          {
            url: urlData.publicUrl,
            name: file.file_name,
            mime_type: file.mime_type || "application/octet-stream",
            size: file.file_size != null ? Number(file.file_size) : undefined,
          },
        ],
      }),
    })
  } catch (err) {
    console.error("[crm-storage/share-team-chat] send route unreachable:", err)
    return NextResponse.json({ error: "Could not reach team chat. Please try again." }, { status: 500 })
  }
  if (!sendRes.ok) {
    const d = await sendRes.json().catch(() => ({}))
    return NextResponse.json({ error: d.error || "Could not send to team chat." }, { status: sendRes.status })
  }
  const sendData = await sendRes.json().catch(() => ({}))

  return NextResponse.json({ ok: true, message_id: sendData.message?.id ?? null })
}
