import { NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { getMailDriver } from "@/lib/marketing/inbox/driver"
import { visibleMailboxes } from "@/lib/marketing/inbox/mailboxes"
import { NO_STORE, teamMailboxes, viewerOf } from "@/lib/marketing/inbox/access"

/** GET — the mailboxes THIS person may open (never the others, never the CRM's), each with its unread number (null when Gmail could not be reached). */
export async function GET() {
  const g = await requireMarketing("inbox")
  if (g.res) return g.res
  const mine = visibleMailboxes(await teamMailboxes(g.ctx.team.id), viewerOf(g.ctx))
  const driver = await getMailDriver()
  const boxes = await Promise.all(mine.map(async b => ({ address: b.address, unread: await driver.unread(b.address).catch(() => null) })))
  return NextResponse.json({ mailboxes: boxes }, { headers: NO_STORE })
}
