import { NextRequest, NextResponse } from "next/server"
import { NO_STORE, createThreadUploadUrl, openThread } from "@/lib/marketing/team-chat-server"

/** POST /api/marketing/team-chat/[threadId]/upload-url { file_name } — a signed link to put one file in this conversation's own folder of the private bucket. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params
  const g = await openThread(threadId)
  if (g.res) return g.res
  const body = (await req.json().catch(() => ({}))) as { file_name?: unknown }
  const r = await createThreadUploadUrl(g.ctx, g.thread, body.file_name)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ signedUrl: r.signedUrl, token: r.token, path: r.path }, { headers: NO_STORE })
}
