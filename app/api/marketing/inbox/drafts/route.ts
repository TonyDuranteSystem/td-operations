import { NextRequest, NextResponse } from "next/server"
import { NO_STORE, requireInbox } from "@/lib/marketing/inbox/access"
import { sendOrDraft } from "@/lib/marketing/inbox/send"

/** POST — save what is written as a draft in the mailbox's own Drafts (same fields as send; nothing is required; attachments are not kept in a draft). */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const a = await requireInbox(body.address)
  if (a.res) return a.res
  const r = await sendOrDraft({ teamId: a.ctx.team.id, userId: a.ctx.user.id, box: a.box, driver: a.driver, body, draft: true })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true, draftId: r.draftId }, { headers: NO_STORE })
}

/** DELETE ?address&draftId — throw a draft away. */
export async function DELETE(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const a = await requireInbox(p.get("address"))
  if (a.res) return a.res
  const id = p.get("draftId")
  if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) return NextResponse.json({ error: "That draft is not valid." }, { status: 400, headers: NO_STORE })
  try { await a.driver.deleteDraft(a.box.address, id) } catch { return NextResponse.json({ error: "Could not delete the draft." }, { status: 502, headers: NO_STORE }) }
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
