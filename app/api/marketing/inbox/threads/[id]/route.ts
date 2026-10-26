import { NextRequest, NextResponse } from "next/server"
import { replyRecipients, subjectFor } from "@/lib/marketing/inbox/compose"
import { NO_STORE, isGmailId, requireInbox } from "@/lib/marketing/inbox/access"

/** GET ?address — the whole thread, plus for every message the answers the screen offers (who a reply / reply-all goes to, the Re: / Fwd: subjects), worked out here so the browser never needs the server-only rules. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const a = await requireInbox(req.nextUrl.searchParams.get("address"))
  if (a.res) return a.res
  if (!isGmailId(id)) return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE })
  try {
    const thread = await a.driver.thread(a.box.address, id)
    if (!thread) return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE })
    const messages = thread.messages.map(m => ({
      ...m,
      suggest: {
        reply: replyRecipients(m, a.box.address, false), replyAll: replyRecipients(m, a.box.address, true),
        subjectRe: subjectFor("reply", m.subject || thread.subject), subjectFwd: subjectFor("forward", m.subject || thread.subject),
      },
    }))
    return NextResponse.json({ ...thread, messages }, { headers: NO_STORE })
  } catch (e) {
    console.error("[marketing] inbox thread failed:", e instanceof Error ? e.message : e)
    return NextResponse.json({ error: "Could not open this email. Please try again." }, { status: 502, headers: NO_STORE })
  }
}
