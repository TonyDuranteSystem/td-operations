import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { validateChatAttachment } from "@/lib/portal/chat-attachment"
import {
  INBOX_EMAIL_BUCKET,
  MAX_EMAIL_ATTACHMENT_TOTAL_BYTES,
  MAX_EMAIL_ATTACHMENT_TOTAL_MB,
} from "@/lib/inbox/email-attachment-staging"
import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"

/**
 * POST /api/inbox/attachments/upload-url
 *
 * Signed direct-to-Storage upload URL for a file a staff member attaches in an
 * Inbox email composer (new email or reply), so the browser bypasses the
 * serverless request-body limit — mirrors /api/inbox/worker-chat/upload-url.
 *
 * Lands in the PRIVATE worker-attachments bucket under its own inbox-email/
 * prefix. The file is read back server-side by path at send time and attached
 * to the outgoing MIME; nothing is ever served from a public URL — an email
 * attachment is routinely a client's passport or EIN letter.
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

  // Same type policy as every other upload (executables stay blocked)...
  const validationError = validateChatAttachment(fileName, fileSize, mimeType)
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 })
  }
  // ...but the EMAIL ceiling: Gmail refuses messages over 25MB total after
  // base64 overhead, so 18MB of raw bytes per email is the honest cap. A single
  // file may use all of it; the send route re-checks the combined total against
  // the actual downloaded bytes. The client checks this too; that's a
  // convenience, this is the control.
  if (fileSize > MAX_EMAIL_ATTACHMENT_TOTAL_BYTES) {
    return NextResponse.json(
      {
        error: `Too large to email: ${(fileSize / 1024 / 1024).toFixed(1)} MB (max ${MAX_EMAIL_ATTACHMENT_TOTAL_MB} MB — Gmail's limit). Send it via a Drive link instead.`,
      },
      { status: 400 }
    )
  }

  // The path shape is enforced again at send time (isValidInboxEmailStagingPath)
  // — the client never chooses it.
  const ext = (fileName.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
  const path = `inbox-email/${randomUUID()}.${ext}`

  const { data, error } = await supabaseAdmin.storage.from(INBOX_EMAIL_BUCKET).createSignedUploadUrl(path)
  if (error || !data) {
    console.error("[inbox-attachments] signed-URL error:", error)
    return NextResponse.json({ error: "Could not start the upload. Please try again." }, { status: 500 })
  }

  // No public URL is returned — there isn't one. The caller hands the path back
  // on send and the server reads the bytes itself.
  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path })
}
