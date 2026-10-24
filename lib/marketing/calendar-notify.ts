/**
 * TD Marketing — telling the team that a call was moved (pure; dev job 9aec66fa, round 2 step 2). The seller and the setter both work a call, so both are told, whoever moved it; the person who
 * moved it is not. Antonio looking in with "View as" tells nobody (his test moves must not buzz a real person's phone). No database here.
 */
import { formatWhen } from "@/lib/marketing/lead-view"

export interface NotifyMember { user_id: string; status?: string; permissions: readonly string[] }

/** Who is told: active members who read leads and work calls (mark, pick or host them), never the person who moved it. */
export function rescheduleRecipients(members: readonly NotifyMember[], moverId: string): string[] {
  const works = (p: readonly string[]) => p.includes("leads.read") && (p.includes("leads.mark") || p.includes("leads.pick") || p.includes("calls.host"))
  return Array.from(new Set(members.filter(m => m.user_id !== moverId && m.status !== "removed" && m.status !== "paused" && works(m.permissions)).map(m => m.user_id)))
}

/** The notification text: who moved which lead, from when to when, and why. */
export function reschedulePush(i: { moverName: string; leadName: string; from: string | null; to: string; reason: string }, locale = "en-GB"): { title: string; body: string } {
  const when = (iso: string) => formatWhen(iso, "Europe/Rome", locale)
  return { title: `${i.moverName} moved a call · ${i.leadName}`, body: `${i.from ? `${when(i.from)} → ` : ""}${when(i.to)}. ${i.reason}` }
}
