import { NextRequest, NextResponse } from "next/server"
import { NO_STORE, createUploadUrl, openChat } from "@/lib/marketing/lead-chat-server"

/** POST /api/marketing/chat/[leadId]/upload-url { file_name } — a signed link to put one file in this lead's own folder of the private bucket. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params
  const g = await openChat(leadId, req.nextUrl.searchParams.get("lane"))
  if (g.res) return g.res
  const body = (await req.json().catch(() => ({}))) as { file_name?: unknown }
  const r = await createUploadUrl(g.ctx, g.lead, body.file_name)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ signedUrl: r.signedUrl, token: r.token, path: r.path }, { headers: NO_STORE })
}
