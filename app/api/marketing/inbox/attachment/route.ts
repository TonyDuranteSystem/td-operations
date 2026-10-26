import { NextRequest, NextResponse } from "next/server"
import { NO_STORE, isGmailId, requireInbox } from "@/lib/marketing/inbox/access"

const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

/**
 * GET ?address&messageId&attachmentId[&mimeType&filename] — one attachment of an email. A real picture shown INSIDE an email (filename=inline, a plain raster type) is served as that picture;
 * EVERYTHING else is served as a download of unknown type, never as something the browser may open on our address (an HTML attachment must never run here).
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const a = await requireInbox(p.get("address"))
  if (a.res) return a.res
  const messageId = p.get("messageId"), attachmentId = p.get("attachmentId")
  if (!isGmailId(messageId) || !attachmentId || !/^[A-Za-z0-9_\-.=]{1,2000}$/.test(attachmentId)) return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE })
  try {
    const data = await a.driver.attachment(a.box.address, messageId, attachmentId)
    const mime = (p.get("mimeType") ?? "").toLowerCase()
    const inline = p.get("filename") === "inline" && INLINE_IMAGES.has(mime)
    const name = (p.get("filename") ?? "attachment").replace(/[\r\n"\\/]/g, "_").slice(0, 120) || "attachment"
    return new NextResponse(new Uint8Array(data), {
      headers: {
        ...NO_STORE,
        "Content-Type": inline ? mime : "application/octet-stream",
        "Content-Disposition": inline ? "inline" : `attachment; filename="${name}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
      },
    })
  } catch (e) {
    console.error("[marketing] inbox attachment failed:", e instanceof Error ? e.message : e)
    return NextResponse.json({ error: "Could not download this file. Please try again." }, { status: 502, headers: NO_STORE })
  }
}
