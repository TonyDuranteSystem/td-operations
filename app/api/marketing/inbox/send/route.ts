import { NextRequest, NextResponse } from "next/server"
import { NO_STORE, requireInbox } from "@/lib/marketing/inbox/access"
import { firstTimeSeen, sendOrDraft } from "@/lib/marketing/inbox/send"

/** POST { address, mode: new | reply | replyAll | forward, threadId?, messageId?, to, cc?, bcc?, subject, messageHtml?, message?, attachments?, draftId?, sendKey? } — send it. */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const a = await requireInbox(body.address)
  if (a.res) return a.res
  if (!firstTimeSeen(body.sendKey, a.ctx.user.id)) return NextResponse.json({ error: "That email was already sent." }, { status: 409, headers: NO_STORE })
  const r = await sendOrDraft({ teamId: a.ctx.team.id, userId: a.ctx.user.id, box: a.box, driver: a.driver, body, draft: false })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true, threadId: r.threadId }, { headers: NO_STORE })
}
