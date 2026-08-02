import { NextRequest, NextResponse } from "next/server"
import { getGmailAttachment } from "@/lib/gmail"
import { checkMailboxAccess } from "@/lib/inbox/mailbox-access"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { storedAttachmentPath } from "@/lib/email-store/read"
import { EMAIL_CONTENT_BUCKET } from "@/lib/email-store/capture"

export const dynamic = "force-dynamic"

/**
 * GET /api/inbox/attachment?messageId=xxx&attachmentId=yyy&filename=zzz&mailbox=support
 * Downloads a Gmail attachment and returns it as a binary response.
 */
export async function GET(req: NextRequest) {
  // Staff gate — middleware only guarantees "is logged in" for /api routes,
  // and a portal CLIENT has a login (2026-07-21 invariant; council find 2026-07-29,
  // dev job 7e63fcd2).
  const denied = await requireStaffRoute()
  if (denied) return denied

  try {
    const messageId = req.nextUrl.searchParams.get("messageId")
    const attachmentId = req.nextUrl.searchParams.get("attachmentId")
    const filename = req.nextUrl.searchParams.get("filename") || "attachment"
    const mimeType = req.nextUrl.searchParams.get("mimeType") || "application/octet-stream"
    const mailbox = req.nextUrl.searchParams.get("mailbox")
    if (!(await checkMailboxAccess(mailbox))) {
      return NextResponse.json({ error: "Not authorized for this mailbox" }, { status: 403 })
    }

    if (!messageId || !attachmentId) {
      return NextResponse.json(
        { error: "messageId and attachmentId are required" },
        { status: 400 }
      )
    }

    const asUser = mailbox === "antonio"
      ? "antonio.durante@tonydurante.us"
      : "support@tonydurante.us"

    // LOCAL-FIRST: serve from our own store when we already hold the bytes —
    // no Gmail call, no quota spend (the 2026-08-02 incident was quota
    // exhaustion). Anything we don't hold falls through to Gmail unchanged.
    try {
      const stored = await storedAttachmentPath(
        mailbox === "antonio" ? "antonio" : "support",
        messageId,
        attachmentId,
      )
      if (stored?.storage_path) {
        const dl = await supabaseAdmin.storage
          .from(EMAIL_CONTENT_BUCKET)
          .download(stored.storage_path)
        if (!dl.error && dl.data) {
          const buf = Buffer.from(await dl.data.arrayBuffer())
          return new NextResponse(new Uint8Array(buf), {
            headers: {
              "Content-Type": stored.mime_type || mimeType,
              "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
              "Content-Length": buf.length.toString(),
            },
          })
        }
      }
    } catch (err) {
      console.warn("[inbox] local attachment read failed, falling back to Gmail:", err)
    }

    const { data } = await getGmailAttachment(messageId, attachmentId, asUser)

    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
        "Content-Length": data.length.toString(),
      },
    })
  } catch (error) {
    console.error("Attachment download error:", error)
    return NextResponse.json(
      { error: "Failed to download attachment" },
      { status: 500 }
    )
  }
}
