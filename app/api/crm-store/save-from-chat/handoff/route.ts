/**
 * GET /api/crm-store/save-from-chat/handoff?messageId=…            — whose storage the chat message belongs to + its files (reads only).
 * GET /api/crm-store/save-from-chat/handoff?messageId=…&index=…    — a short-lived link to ONE attachment, so the Storage screen in the
 *                                                                    Portal Chats pop-up can fetch the bytes itself.
 * Staff only. The file always comes from the SAVED message, never from a url in the request (dev job fb49265a; Antonio 2026-11-09).
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../../browse/_auth"

export async function GET(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const messageId = req.nextUrl.searchParams.get("messageId") ?? ""
  if (!messageId) return NextResponse.json({ error: "Say which message." }, { status: 400 })
  const rawIndex = req.nextUrl.searchParams.get("index")
  try {
    const { readHandoffTarget, signChatFile } = await import("@/lib/crm-store/chat-file-handoff")
    if (rawIndex !== null) {
      const index = Number(rawIndex)
      if (!Number.isInteger(index) || index < 0) return NextResponse.json({ error: "Say which attachment." }, { status: 400 })
      const f = await signChatFile(messageId, index)
      if ("error" in f) return NextResponse.json({ error: f.error }, { status: f.status })
      return NextResponse.json(f, { headers: { "Cache-Control": "no-store" } })
    }
    const t = await readHandoffTarget(messageId)
    if ("error" in t) return NextResponse.json({ error: t.error }, { status: t.status })
    return NextResponse.json(t, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error && e.message ? e.message : "Could not prepare the file — please try again." }, { status: 500 })
  }
}
