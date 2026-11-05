import { NextRequest } from "next/server"
import { appGate } from "@/lib/app/gate"
import { appJson } from "@/lib/app/http"
import { markInboxOpened } from "@/lib/app/state"
import { tabsFor } from "@/lib/app/tabs"

export const dynamic = "force-dynamic"

/**
 * POST /api/marketing/app/seen — TD Social: "I opened this mailbox now" (dev job 2072bc3e, Step 2 pull request B).
 *
 * Body: { mailbox: "support" | "antonio" }. The time is the SERVER's clock (a phone's clock is not trusted), the mailbox must be one this person
 * may open (the Inbox tab's own list, which follows the existing mailbox rule), and the stored time only ever moves forward. It resets the
 * "new mail since you last opened" number for that mailbox.
 */
export async function POST(request: NextRequest) {
  const g = await appGate()
  if (g.res) return g.res
  const inbox = tabsFor(g.who.identity).find(t => t.id === "inbox")
  if (!inbox) return appJson({ error: "You do not have the Inbox.", code: "NO_INBOX" }, 403)
  const body = await request.json().catch(() => null) as { mailbox?: unknown } | null
  const mailbox = body && typeof body === "object" ? body.mailbox : undefined
  if (typeof mailbox !== "string" || mailbox === "") return appJson({ error: "Send the mailbox you opened.", code: "BAD_BODY" }, 400)
  if (!(inbox.mailboxes ?? []).includes(mailbox)) return appJson({ error: "You may not open this mailbox.", code: "MAILBOX_NOT_ALLOWED" }, 403)
  try {
    const openedAt = await markInboxOpened(g.who.user.id, mailbox, new Date())
    return appJson({ ok: true, openedAt })
  } catch (e) {
    console.error("[social-app] seen write failed:", e instanceof Error ? e.message : "unknown")
    return appJson({ error: "Could not save this. Please try again.", code: "DB_ERROR" }, 500)
  }
}
