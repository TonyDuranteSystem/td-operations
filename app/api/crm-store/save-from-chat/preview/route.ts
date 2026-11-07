/**
 * GET /api/crm-store/save-from-chat/preview?messageId=…&index=… — one chat attachment, inline, so the card can show the scan next to what was
 * read from it (Antonio 2026-11-07). Staff only. The file comes from the SAVED message (never from a url in the request). A PDF is served
 * the way Storage serves the same kind of file to staff (inline); a picture also gets the chat's `sandbox` policy.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../../browse/_auth"

export async function GET(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const messageId = req.nextUrl.searchParams.get("messageId") ?? ""
  const index = Number(req.nextUrl.searchParams.get("index"))
  if (!messageId || !Number.isInteger(index) || index < 0) return NextResponse.json({ error: "Say which attachment." }, { status: 400 })
  try {
    const { readChatAttachmentForPreview } = await import("@/lib/crm-store/save-from-chat")
    const f = await readChatAttachmentForPreview(messageId, index)
    if ("error" in f) return NextResponse.json({ error: f.error }, { status: f.status })
    const { staffFileHeaders, chatAttachmentHeaders } = await import("@/lib/crm-store/serve")
    const headers = f.mime === "application/pdf" ? staffFileHeaders(f.mime, f.name) : chatAttachmentHeaders(f.mime, f.name)
    return new NextResponse(new Uint8Array(f.bytes), { headers })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The file is not available." }, { status: 500 })
  }
}
