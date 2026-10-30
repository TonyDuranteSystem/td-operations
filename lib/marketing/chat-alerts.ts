/**
 * TD Marketing — the messages the spoken alert reads out (server; dev job 9aec66fa, 29 Oct 2026). For one person: what other people wrote in HIS chats (the chats about leads he may read, through the same
 * lanes as his unread numbers, and his direct messages and groups) since a time, still unread. The answer carries only the sender's first name and the time: never the words of a message.
 */
import type { MarketingContext } from "@/lib/marketing/guard"
import { hasPermission } from "@/lib/marketing/permissions"
import { isInvolved } from "@/lib/marketing/lead-chat"
import { chatMembers, newLeadMessages } from "@/lib/marketing/lead-chat-server"
import { newTeamMessages } from "@/lib/marketing/team-chat-server"
import { firstNameOf, VOICE_MAX_ITEMS, type VoiceAlertItem } from "@/lib/marketing/voice-alert"

export async function chatAlerts(ctx: MarketingContext, sinceIso: string): Promise<VoiceAlertItem[]> {
  // the same two doors as the red number: any chat access for direct messages and groups, plus the right to read leads (and work them) for the chats about leads
  if (!hasPermission(ctx.permissions, "chat")) return []
  const leadChats = hasPermission(ctx.permissions, "leads.read") && isInvolved(ctx.permissions)
  const noMembers: Awaited<ReturnType<typeof chatMembers>> = []
  const [lead, team, members] = await Promise.all([
    leadChats ? newLeadMessages(ctx, sinceIso) : Promise.resolve([]),
    newTeamMessages(ctx, sinceIso),
    chatMembers(ctx.team.id).catch(() => noMembers),
  ])
  const names = new Map<string, string>(members.map(m => [m.id, firstNameOf(m.name)] as [string, string]))
  return [...lead.map(m => ({ ...m, kind: "lead" as const })), ...team.map(m => ({ ...m, kind: "team" as const }))]
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    .slice(-VOICE_MAX_ITEMS)
    .map(m => ({ id: m.id, kind: m.kind, sender: names.get(m.sender_id) ?? "", at: m.created_at }))
}
