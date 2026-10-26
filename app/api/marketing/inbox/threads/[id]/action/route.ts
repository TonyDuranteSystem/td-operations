import { NextRequest, NextResponse } from "next/server"
import { isThreadAction } from "@/lib/marketing/inbox/mail-types"
import { NO_STORE, isGmailId, requireInbox } from "@/lib/marketing/inbox/access"

/** POST { address, action: read | unread | archive | trash | star | unstar } — on the whole thread. Trash goes to Gmail's bin (kept 30 days there), nothing is erased. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const a = await requireInbox(body.address)
  if (a.res) return a.res
  if (!isGmailId(id)) return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE })
  if (!isThreadAction(body.action)) return NextResponse.json({ error: "Unknown action." }, { status: 400, headers: NO_STORE })
  try {
    await a.driver.act(a.box.address, id, body.action)
    return NextResponse.json({ ok: true }, { headers: NO_STORE })
  } catch (e) {
    console.error("[marketing] inbox action failed:", e instanceof Error ? e.message : e)
    return NextResponse.json({ error: "That did not work. Please try again." }, { status: 502, headers: NO_STORE })
  }
}
