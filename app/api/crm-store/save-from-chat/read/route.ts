/**
 * POST /api/crm-store/save-from-chat/read — the "Save to Storage" card asks: what are the attachments of this chat message, whose are
 * they, where would they go, what did the reader find? (Antonio 2026-11-07, dev job fb49265a.) Staff only. READS ONLY — it saves and
 * changes nothing; the only cost is one OCR read per file.
 * Body: { messageId }   Answer: CardResponse (lib/crm-store/save-from-chat-rules.ts) or { error }.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../../browse/_auth"

export async function POST(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as { messageId?: unknown }
  if (typeof body.messageId !== "string") return NextResponse.json({ error: "Say which message." }, { status: 400 })
  try {
    const { readChatAttachmentsForCard } = await import("@/lib/crm-store/save-from-chat")
    const r = await readChatAttachmentsForCard(body.messageId)
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the attachments — please try again." }, { status: 500 })
  }
}
