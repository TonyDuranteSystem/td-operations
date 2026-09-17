import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { validateChatAttachment } from "@/lib/portal/chat-attachment"
import { WHATSAPP_ATTACHMENT_BUCKET, MAX_WHATSAPP_ATTACHMENT_BYTES } from "@/lib/messaging/attachment-staging"
import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"

/**
 * POST /api/inbox/whatsapp-new/upload-url
 *
 * Signed direct-to-Storage upload URL for a file staff attaches when starting
 * a new WhatsApp conversation. Lands in the PRIVATE worker-attachments bucket
 * under its own whatsapp-new/ prefix (see lib/messaging/attachment-staging.ts
 * for why: private storage, not the public assets bucket Portal Chats uses —
 * a lead-shared attachment is routinely an ID document).
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

  // Same type policy as every other chat upload in this codebase (executables
  // and active-content types stay blocked).
  const validationError = validateChatAttachment(fileName, fileSize, mimeType)
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 })
  }
  if (fileSize > MAX_WHATSAPP_ATTACHMENT_BYTES) {
    const mb = MAX_WHATSAPP_ATTACHMENT_BYTES / 1024 / 1024
    return NextResponse.json(
      { error: `Too large: ${(fileSize / 1024 / 1024).toFixed(1)} MB (max ${mb} MB, also 2Chat's own 16MB limit applies).` },
      { status: 400 },
    )
  }

  // The path shape is enforced again when the send route resolves it — the
  // client never chooses it.
  const ext = (fileName.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
  const path = `whatsapp-new/${randomUUID()}.${ext}`

  const { data, error } = await supabaseAdmin.storage.from(WHATSAPP_ATTACHMENT_BUCKET).createSignedUploadUrl(path)
  if (error || !data) {
    console.error("[whatsapp-new] signed-URL error:", error)
    return NextResponse.json({ error: "Could not start the upload. Please try again." }, { status: 500 })
  }

  return NextResponse.json({ signedUrl: data.signedUrl, token: data.token, path })
}
