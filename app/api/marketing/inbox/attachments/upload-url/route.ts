import { NextRequest, NextResponse } from "next/server"
import { createInboxUploadUrl } from "@/lib/marketing/inbox/staging"
import { NO_STORE, requireInbox } from "@/lib/marketing/inbox/access"

/** POST { address, file_name } — a one-time address to upload ONE attachment to (the file never passes through our server on the way in). */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const a = await requireInbox(body.address)
  if (a.res) return a.res
  const r = await createInboxUploadUrl(a.ctx.team.id, a.ctx.user.id, body.file_name)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ signedUrl: r.signedUrl, token: r.token, path: r.path }, { headers: NO_STORE })
}
