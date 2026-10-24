import { NextRequest, NextResponse } from "next/server"
import { NO_STORE, groupAction, loadThread, openThread } from "@/lib/marketing/team-chat-server"
import type { GroupAction } from "@/lib/marketing/team-chat"

/** GET /api/marketing/team-chat/[threadId] — one conversation I am in. `?mark_read=0` (the screen is in the background) reads without marking read. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params
  const g = await openThread(threadId)
  if (g.res) return g.res
  const markRead = req.nextUrl.searchParams.get("mark_read") !== "0"
  return NextResponse.json(await loadThread(g.ctx, { thread: g.thread, memberIds: g.memberIds }, markRead), { headers: NO_STORE })
}

/** PATCH /api/marketing/team-chat/[threadId] { action: "rename", title } | { action: "add", memberIds } | { action: "leave" } — a group's name, its people, or me leaving it. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params
  const g = await openThread(threadId)
  if (g.res) return g.res
  const b = (await req.json().catch(() => ({}))) as { action?: unknown; title?: unknown; memberIds?: unknown }
  const input: GroupAction | null = b.action === "rename" ? { action: "rename", title: b.title } : b.action === "add" ? { action: "add", memberIds: b.memberIds } : b.action === "leave" ? { action: "leave" } : null
  if (!input) return NextResponse.json({ error: "That request is not valid." }, { status: 400, headers: NO_STORE })
  const r = await groupAction(g.ctx, { thread: g.thread, memberIds: g.memberIds }, input)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
