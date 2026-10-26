import { NextRequest, NextResponse } from "next/server"
import { isFolder } from "@/lib/marketing/inbox/mail-types"
import { NO_STORE, requireInbox } from "@/lib/marketing/inbox/access"

/** GET ?address&folder&q&pageToken — one page of the list. */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams
  const a = await requireInbox(p.get("address"))
  if (a.res) return a.res
  const folder = p.get("folder") ?? "inbox"
  if (!isFolder(folder)) return NextResponse.json({ error: "Unknown folder." }, { status: 400, headers: NO_STORE })
  const token = p.get("pageToken")
  if (token !== null && !/^[A-Za-z0-9_\-=.]{1,300}$/.test(token)) return NextResponse.json({ error: "Bad page." }, { status: 400, headers: NO_STORE })
  try {
    const page = await a.driver.list(a.box.address, folder, (p.get("q") ?? "").slice(0, 300), token)
    return NextResponse.json(page, { headers: NO_STORE })
  } catch (e) {
    console.error("[marketing] inbox list failed:", e instanceof Error ? e.message : e)
    return NextResponse.json({ error: "Could not reach the mailbox. Please try again." }, { status: 502, headers: NO_STORE })
  }
}
