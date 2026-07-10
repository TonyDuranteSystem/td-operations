import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { validateChatAttachment } from "@/lib/portal/chat-attachment"
import { WORKER_UPLOAD_BUCKET } from "@/lib/ai-agent/attachment-reader"
import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"

/**
 * POST /api/inbox/worker-chat/upload-url
 *
 * Signed direct-to-Storage upload URL for a file a staff member pastes or drops
 * into a CRM worker panel, so the browser bypasses the serverless request-body
 * limit (a base64 screenshot in the POST body would 413 at the platform edge).
 *
 * Lands in the PRIVATE `worker-attachments` bucket. Unlike portal/team chat
 * attachments — which sit in the public `assets` bucket — these files are read
 * back server-side by path with the service key and are never served from a
 * public URL. The staff member's file may be a client's affidavit or passport.
 *
 * Staff-only. Body: { file_name, file_size, mime_type }.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const fileName: string | null = typeof body.file_name === "string" ? body.file_name : null
  const fileSize: number = typeof body.file_size === "number" ? body.file_size : 0
  const mimeType: string = typeof body.mime_type === "string" ? body.mime_type : ""
  if (!fileName) return NextResponse.json({ error: "file_name required" }, { status: 400 })

  // Same size/type policy as every other chat upload — one place decides what a
  // "normal file" is, so the surfaces never drift (executables stay blocked).
  const validationError = validateChatAttachment(fileName, fileSize, mimeType)
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 })
  }

  // The path shape is enforced again on read (isValidWorkerUploadPath) — the
  // client never chooses it.
  const ext = (fileName.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
  const path = `worker-chat/${randomUUID()}.${ext}`

  const { data, error } = await supabaseAdmin.storage.from(WORKER_UPLOAD_BUCKET).createSignedUploadUrl(path)
  if (error || !data) {
    console.error("[worker-chat] signed-URL error:", error)
    return NextResponse.json({ error: "Could not start the upload. Please try again." }, { status: 500 })
  }

  // No public URL is returned — there isn't one. The caller hands the path back
  // on the next worker-chat POST and the server reads the bytes itself.
  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path })
}
