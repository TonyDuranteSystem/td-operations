/**
 * Reads what the owner's Home needs (server; TD Marketing, dev job 9aec66fa): the team's leads, this month's payment history, the booked calls, my unread lead chats and direct messages.
 * Used by the workspace Home and by the CRM's Marketing page, so both always show the same thing. Every read is team-scoped by the guard's context.
 */
import type { MarketingContext } from "@/lib/marketing/guard"
import { hasPermission } from "@/lib/marketing/permissions"
import { getMarketingSetting } from "@/lib/marketing/settings"
import { listTeamLeadsCapped } from "@/lib/marketing/leads-read"
import { leadDb } from "@/lib/marketing/meta-leads/service"
import { romeStartOfMonth, type StageOpt } from "@/lib/marketing/master-view"
import { loadTeamEvents } from "@/lib/marketing/events-read"
import { loadCalendarData } from "@/lib/marketing/calendar-read"
import { listConversations } from "@/lib/marketing/lead-chat-server"
import { listThreads } from "@/lib/marketing/team-chat-server"
import { isInvolved } from "@/lib/marketing/lead-chat"
import { homeModel, type HomeLead, type HomeModel } from "@/lib/marketing/home"

export async function loadOwnerHome(ctx: MarketingContext, now: Date, unnamed: string): Promise<{ model: HomeModel; truncated: boolean; chatAny: boolean }> {
  const perms = ctx.permissions
  const db = leadDb()
  const teamId = ctx.team.id
  const chatAny = hasPermission(perms, "chat")
  const leadChat = chatAny && hasPermission(perms, "leads.read") && isInvolved(perms)
  const [leadsRes, stages, ev, cal, conversations, threads] = await Promise.all([
    listTeamLeadsCapped(db, teamId, 2000),
    getMarketingSetting("pipeline_stages", teamId) as Promise<StageOpt[]>,
    loadTeamEvents(db, teamId, { since: romeStartOfMonth(now), kinds: ["payment_link_created", "payment_received"] }),
    loadCalendarData(db, teamId),
    leadChat ? listConversations(ctx, { withMentions: true }) : Promise.resolve([]),
    chatAny ? listThreads(ctx).then(s => s.threads) : Promise.resolve([]),
  ])
  const model = homeModel({
    leads: leadsRes.rows as unknown as HomeLead[], events: ev.events, conversations, threads,
    calls: cal.appointments.map(a => ({ lead: a.lead, at: a.at, actor: a.actor })),
    now, firstStage: stages[0]?.key, unnamed,
  })
  return { model, truncated: leadsRes.truncated || ev.truncated, chatAny }
}
