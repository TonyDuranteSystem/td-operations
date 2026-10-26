import { NextRequest, NextResponse } from "next/server"
import { deleteStaged, isOwnInboxPath } from "@/lib/marketing/inbox/staging"
import { NO_STORE, requireInbox } from "@/lib/marketing/inbox/access"

/** DELETE { address, path } — throw away ONE attachment the person uploaded and did not send (removed from the email, or the email was closed). Only paths inside his own folder count. */
export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const a = await requireInbox(body.address)
  if (a.res) return a.res
  if (!isOwnInboxPath(body.path, a.ctx.team.id, a.ctx.user.id)) return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE })
  await deleteStaged([body.path])
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
