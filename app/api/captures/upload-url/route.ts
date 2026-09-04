import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { validateChatAttachment } from "@/lib/portal/chat-attachment"
import { WORKER_UPLOAD_BUCKET, MAX_ATTACHMENT_BYTES } from "@/lib/ai-agent/attachment-reader"
import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"

/**
 * POST /api/captures/upload-url
 *
 * Signed direct-to-Storage upload URL for the Capture/Share feature (screenshot
 * + mark-up tool). Lands in the same PRIVATE `worker-attachments` bucket the
 * worker panels already use — never the public `assets` bucket team/portal
 * chat attachments sit in. A capture routinely shows client SSNs/bank/tax data
 * on screen, so it gets the same no-public-URL treatment as a pasted passport
 * or affidavit: the browser uploads via a short-lived signed URL, and the
 * server reads bytes back by path with the service key. Own path prefix
 * (`captures/`), kept separate from `worker-chat/`'s own path convention on
 * purpose — two unrelated features should not share one regex to maintain.
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

  // Same type policy as every other chat upload (executables stay blocked) —
  // captures can arrive via drag-and-drop or paste, not only a fresh capture,
  // so this is real input validation, not a formality.
  const validationError = validateChatAttachment(fileName, fileSize, mimeType)
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 })
  }
  if (fileSize > MAX_ATTACHMENT_BYTES) {
    const mb = MAX_ATTACHMENT_BYTES / 1024 / 1024
    return NextResponse.json(
      { error: `Too large: ${(fileSize / 1024 / 1024).toFixed(1)} MB (max ${mb} MB).` },
      { status: 400 },
    )
  }

  // Server-generated path — the client never chooses it. No user-id segment:
  // "whose capture is this" is a database fact (staff_captures.captured_by_user_id),
  // checked in application code, not a folder-structure convention.
  const ext = (fileName.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "png"
  const path = `captures/${randomUUID()}.${ext}`

  const { data, error } = await supabaseAdmin.storage.from(WORKER_UPLOAD_BUCKET).createSignedUploadUrl(path)
  if (error || !data) {
    console.error("[captures] signed-URL error:", error)
    return NextResponse.json({ error: "Could not start the upload. Please try again." }, { status: 500 })
  }

  // No public URL — there isn't one, same as every other worker-attachments upload.
  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path })
}
