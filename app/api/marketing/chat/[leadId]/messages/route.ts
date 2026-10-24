import { NextRequest, NextResponse } from "next/server"
import { NO_STORE, openChat, sendChatMessage } from "@/lib/marketing/lead-chat-server"

/** POST /api/marketing/chat/[leadId]/messages { message, reply_to_id?, attachments? } — send. Files must already be in this lead's own folder (see upload-url). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params
  const g = await openChat(leadId)
  if (g.res) return g.res
  const body = (await req.json().catch(() => ({}))) as { message?: unknown; attachments?: unknown; reply_to_id?: unknown }
  const r = await sendChatMessage(g.ctx, g.lead, body)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ message: r.message }, { headers: NO_STORE })
}
