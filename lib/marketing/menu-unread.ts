import type { MarketingContext } from "@/lib/marketing/guard"
import { hasPermission } from "@/lib/marketing/permissions"
import { isInvolved } from "@/lib/marketing/lead-chat"
import { unreadByLead } from "@/lib/marketing/lead-chat-server"
import { unreadByThread } from "@/lib/marketing/team-chat-server"

const sum = (m: Map<string, number>) => Array.from(m.values()).reduce((a, b) => a + b, 0)

/**
 * TD Marketing — the one red number (dev job 9aec66fa): my unread messages in the chats about leads (for people who work the leads) plus in my direct messages and groups.
 * Shown on the workspace's Chat item AND on the CRM menu's Marketing item (for an admin who has joined a team), so both always agree.
 */
export async function marketingChatUnread(ctx: Pick<MarketingContext, "permissions" | "team" | "user" | "role" | "membership">): Promise<number> {
  const chatAny = hasPermission(ctx.permissions, "chat")
  const chatOn = chatAny && hasPermission(ctx.permissions, "leads.read")
  const full = ctx as MarketingContext
  const [lead, team] = await Promise.all([chatOn && isInvolved(ctx.permissions) ? unreadByLead(full).then(sum) : 0, chatAny ? unreadByThread(full).then(sum) : 0])
  return lead + team
}
