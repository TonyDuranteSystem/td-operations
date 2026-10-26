/**
 * TD Marketing — the one door every Inbox route goes through (server; dev job 9aec66fa): the person must be a team member who holds the `inbox` right, and the mailbox he names must be one he may open
 * (`findOpenable`: in the team's list, never a CRM mailbox, listed for him / his own address / Antonio). Everything else gets the same plain "not found", so a route can never be used to probe
 * which addresses exist. Under "View as" Antonio is treated as himself (he may open every address).
 */
import { NextResponse } from "next/server"
import { requireMarketing, type MarketingContext } from "@/lib/marketing/guard"
import { getMarketingSetting } from "@/lib/marketing/settings"
import { findOpenable, type InboxMailbox } from "@/lib/marketing/inbox/mailboxes"
import { getMailDriver, type MailDriver } from "@/lib/marketing/inbox/driver"

export const NO_STORE = { "Cache-Control": "no-store" }
const NOT_FOUND = () => NextResponse.json({ error: "Mailbox not found." }, { status: 404, headers: NO_STORE })

export async function teamMailboxes(teamId: string): Promise<InboxMailbox[]> {
  const v = await getMarketingSetting("inbox_mailboxes", teamId)
  return Array.isArray(v) ? (v as InboxMailbox[]) : []
}

export const viewerOf = (ctx: MarketingContext) => ({ id: ctx.user.id, email: ctx.user.email, admin: !!ctx.admin })

export async function requireInbox(address: unknown): Promise<{ ctx: MarketingContext; box: InboxMailbox; driver: MailDriver; res?: undefined } | { res: NextResponse; ctx?: undefined; box?: undefined; driver?: undefined }> {
  const g = await requireMarketing("inbox")
  if (g.res) return { res: g.res }
  const box = findOpenable(await teamMailboxes(g.ctx.team.id), viewerOf(g.ctx), address)
  if (!box) return { res: NOT_FOUND() }
  return { ctx: g.ctx, box, driver: await getMailDriver() }
}

/** A Gmail thread / message / attachment id as it may appear in an address: letters, digits, - and _ only. */
export const isGmailId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v)
