import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { getGmailAttachment } from "@/lib/gmail"
import { checkMailboxAccess } from "@/lib/inbox/mailbox-access"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { storedAttachmentPath } from "@/lib/email-store/read"
import { EMAIL_CONTENT_BUCKET } from "@/lib/email-store/capture"
import { validateChatAttachment } from "@/lib/portal/chat-attachment"
import {
  INBOX_EMAIL_BUCKET,
  MAX_EMAIL_ATTACHMENT_TOTAL_BYTES,
  MAX_EMAIL_ATTACHMENT_TOTAL_MB,
} from "@/lib/inbox/email-attachment-staging"

export const dynamic = "force-dynamic"

/**
 * POST /api/inbox/attachments/copy-from-message
 *
 * Copies ONE attachment (or inline image) from an already-received email into
 * the same staging bucket a manual upload lands in — so Forward can offer the
 * original's files as ordinary, removable chips without the human downloading
 * and re-uploading them (Antonio, 2026-08-28). Reuses the compose/reply
 * send path unchanged: the returned {path, name, mime_type} is exactly what
 * `attachments` already accepts on POST /api/inbox/compose.
 *
 * Bytes never touch the browser here — server reads from our local store
 * (LOCAL-FIRST, same as /api/inbox/attachment) or live Gmail, then writes
 * straight to storage. No signed-URL exchange needed (unlike a real upload,
 * which must dodge the platform's request-body limit from the client side).
 *
 * Staff-only. Body: { messageId, attachmentId, filename, mimeType, mailbox? }.
 */
export async function POST(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const body = await req.json().catch(() => ({}))
  const messageId = typeof body.messageId === "string" ? body.messageId : ""
  const attachmentId = typeof body.attachmentId === "string" ? body.attachmentId : ""
  const filename = typeof body.filename === "string" && body.filename ? body.filename : "attachment"
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream"
  const mailboxParam = body.mailbox === "antonio" ? "antonio" : "support"

  if (!messageId || !attachmentId) {
    return NextResponse.json({ error: "messageId and attachmentId are required" }, { status: 400 })
  }
  if (!(await checkMailboxAccess(mailboxParam))) {
    return NextResponse.json({ error: "Not authorized for this mailbox" }, { status: 403 })
  }

  // Same type policy as a manual attachment upload (executables blocked).
  const validationError = validateChatAttachment(filename, 0, mimeType)
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 })
  }

  const asUser = mailboxParam === "antonio" ? "antonio.durante@tonydurante.us" : "support@tonydurante.us"

  try {
    // LOCAL-FIRST: serve from our own store when we already hold the bytes —
    // no Gmail call, no quota spend (mirrors /api/inbox/attachment).
    let data: Uint8Array | null = null
    try {
      const stored = await storedAttachmentPath(mailboxParam, messageId, attachmentId)
      if (stored?.storage_path) {
        const dl = await supabaseAdmin.storage.from(EMAIL_CONTENT_BUCKET).download(stored.storage_path)
        if (!dl.error && dl.data) data = new Uint8Array(await dl.data.arrayBuffer())
      }
    } catch (err) {
      console.warn("[inbox] local attachment read failed, falling back to Gmail:", err)
    }
    if (!data) {
      const gmail = await getGmailAttachment(messageId, attachmentId, asUser)
      data = gmail.data
    }

    // The client's declared size is a courtesy; this is the control — same
    // rule the send route already applies to a normal upload.
    if (data.length > MAX_EMAIL_ATTACHMENT_TOTAL_BYTES) {
      return NextResponse.json(
        {
          error: `Too large to email: ${(data.length / 1024 / 1024).toFixed(1)} MB (max ${MAX_EMAIL_ATTACHMENT_TOTAL_MB} MB — Gmail's limit).`,
        },
        { status: 400 }
      )
    }

    const ext = (filename.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
    const path = `inbox-email/${randomUUID()}.${ext}`
    const { error: uploadError } = await supabaseAdmin.storage
      .from(INBOX_EMAIL_BUCKET)
      .upload(path, Buffer.from(data), { contentType: mimeType || "application/octet-stream" })
    if (uploadError) {
      console.error("[inbox-attachments] copy-from-message upload error:", uploadError)
      return NextResponse.json({ error: "Could not copy the file. Please try again." }, { status: 500 })
    }

    return NextResponse.json({ path, name: filename, mime_type: mimeType, size: data.length })
  } catch (error) {
    console.error("[inbox-attachments] copy-from-message error:", error)
    return NextResponse.json({ error: "Could not copy the original file. Please try again." }, { status: 500 })
  }
}
