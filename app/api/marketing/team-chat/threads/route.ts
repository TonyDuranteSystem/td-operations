import { NextRequest, NextResponse } from "next/server"
import { NO_STORE, createGroup, listThreads, openDm, requireTeamChat } from "@/lib/marketing/team-chat-server"

/** GET /api/marketing/team-chat/threads — my conversations (newest / unread first) and the people I can start a chat with. The team comes from the guard. */
export async function GET() {
  const g = await requireTeamChat()
  if (g.res) return g.res
  return NextResponse.json(await listThreads(g.ctx), { headers: NO_STORE })
}

/** POST /api/marketing/team-chat/threads { kind: "dm", user_id } | { kind: "group", title, member_ids } — open (or start) a direct message, or create a group. */
export async function POST(req: NextRequest) {
  const g = await requireTeamChat()
  if (g.res) return g.res
  const body = (await req.json().catch(() => ({}))) as { kind?: unknown; user_id?: unknown; title?: unknown; member_ids?: unknown }
  const r = body.kind === "dm" ? await openDm(g.ctx, body.user_id) : body.kind === "group" ? await createGroup(g.ctx, body) : null
  if (r === null) return NextResponse.json({ error: "That request is not valid." }, { status: 400, headers: NO_STORE })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ thread_id: r.threadId }, { headers: NO_STORE })
}
