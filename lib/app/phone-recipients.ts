/**
 * TD Social — who a phone alert may go to, checked AGAIN at send time (server; dev job 2072bc3e, Step 2 pull request C2; Council-reviewed plan of 5 Nov 2026).
 *
 * The two existing senders already received a list of people from their callers. The phone leg does not trust it: it re-checks against the same sources the
 * rest of the system uses, and any doubt means nobody (fail CLOSED), because a phone alert reaches a lock screen.
 *  - Staff alerts: only people the staff directory still lists (it already leaves out banned logins, partners, clients and non-staff).
 *  - Marketing alerts: only people with an ACTIVE membership in THAT alert's team, the team LIVE, and the chat permission. A person in two teams never gets the
 *    wrong team's alerts; a paused person or a paused team gets nothing.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { listTeamMembers } from "@/lib/team/directory"
import { effectivePermissions, hasPermission } from "@/lib/marketing/permissions"
import { isTeamLive } from "@/lib/marketing/team-status"
import { getMarketingSetting } from "@/lib/marketing/settings"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the marketing tables are newer than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any }

export interface MemberRow { user_id: string; member_role: "owner" | "member"; status: string; bundle: string | null; permissions: string[] | null }

/** PURE: which of these members may be told. `bundles` are the team's permission bundles. */
export function marketingRecipientsFrom(members: readonly MemberRow[], team: { status: unknown } | null, bundles: Record<string, string[]>): string[] {
  if (!team || !isTeamLive(team.status)) return []
  return members
    .filter(m => m.status === "active")
    .filter(m => hasPermission(effectivePermissions({ memberRole: m.member_role, bundle: m.bundle, bundles, extra: m.permissions ?? [] }), "chat"))
    .map(m => m.user_id)
}

/** The staff among these ids, as the staff directory knows them now. Any failure = nobody. */
export async function staffRecipients(ids: readonly string[]): Promise<string[]> {
  try {
    const staff = new Set((await listTeamMembers()).map(m => m.id))
    return Array.from(new Set(ids)).filter(id => staff.has(id))
  } catch {
    return []
  }
}

/** The people of ONE team who may be told. Any failure = nobody. */
export async function marketingRecipients(teamId: string, ids: readonly string[]): Promise<string[]> {
  if (!teamId || ids.length === 0) return []
  try {
    const [{ data: members, error: mErr }, { data: team, error: tErr }] = await Promise.all([
      db().from("marketing_team_members").select("user_id, member_role, status, bundle, permissions").eq("team_id", teamId).in("user_id", Array.from(new Set(ids))),
      db().from("marketing_teams").select("id, status").eq("id", teamId).maybeSingle(),
    ])
    if (mErr || tErr) return []
    const bundles = (await getMarketingSetting("permission_bundles", teamId)) as Record<string, string[]>
    return marketingRecipientsFrom((members ?? []) as MemberRow[], (team ?? null) as { status: unknown } | null, bundles ?? {})
  } catch {
    return []
  }
}
