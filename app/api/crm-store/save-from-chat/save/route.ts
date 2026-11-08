/**
 * POST /api/crm-store/save-from-chat/save — the "Save to Storage" card saves what staff confirmed (Antonio 2026-11-07, dev job fb49265a).
 * Staff only. For each file: the letter goes into the person's own storage (ITIN folder), HIDDEN; the ITIN / issue date are written on the
 * contact only as confirmed (never over what the record holds without "replace"); the client is shown / notified ONLY as chosen
 * (default nothing, never a chat line). A failure on one file never stops the others.
 * Body: { messageId, items: [{ index, contactId, fileName, itin, issueDate, client: "hidden"|"show_silent"|"show_notify", replaceItin }] }
 * Answer: { results: SaveItemResult[] } or { error }.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { denyUnlessStoreStaff } from "../../browse/_auth"
import { createClient } from "@/lib/supabase/server"

export async function POST(req: NextRequest) {
  const denied = await denyUnlessStoreStaff()
  if (denied) return denied
  const body = (await req.json().catch(() => ({}))) as { messageId?: unknown }
  if (typeof body.messageId !== "string") return NextResponse.json({ error: "Say which message." }, { status: 400 })
  try {
    const { saveChatAttachmentsToStorage } = await import("@/lib/crm-store/save-from-chat")
    const { parseSaveItems } = await import("@/lib/crm-store/save-from-chat-rules")
    const items = parseSaveItems(body)
    if (!items) return NextResponse.json({ error: "Nothing to save — choose at least one file." }, { status: 400 })
    const { data: { user } } = await createClient().auth.getUser()
    const r = await saveChatAttachmentsToStorage(body.messageId, items, user?.id ?? null)
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ results: r.results }, { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not save — please try again." }, { status: 500 })
  }
}
