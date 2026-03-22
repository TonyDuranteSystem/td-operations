import { NextRequest, NextResponse } from "next/server"
import { getGmailAttachment } from "@/lib/gmail"

export const dynamic = "force-dynamic"

/**
 * GET /api/inbox/attachment?messageId=xxx&attachmentId=yyy&filename=zzz&mailbox=support
 * Downloads a Gmail attachment and returns it as a binary response.
 */
export async function GET(req: NextRequest) {
  try {
    const messageId = req.nextUrl.searchParams.get("messageId")
    const attachmentId = req.nextUrl.searchParams.get("attachmentId")
    const filename = req.nextUrl.searchParams.get("filename") || "attachment"
    const mimeType = req.nextUrl.searchParams.get("mimeType") || "application/octet-stream"
    const mailbox = req.nextUrl.searchParams.get("mailbox")

    if (!messageId || !attachmentId) {
      return NextResponse.json(
        { error: "messageId and attachmentId are required" },
        { status: 400 }
      )
    }

    const asUser = mailbox === "antonio"
      ? "antonio.durante@tonydurante.us"
      : "support@tonydurante.us"

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
