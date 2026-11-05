/**
 * TD Social — who a phone alert may go to, checked AGAIN at send time (server; dev job 2072bc3e, Step 2 pull request C2; Council-reviewed plan of 5 Nov 2026).
 *
 * The two existing senders already received a list of people from their callers. The phone leg does not trust it: it re-checks against the same sources the
 * rest of the system uses, and any doubt means nobody (fail CLOSED), because a phone alert reaches a lock screen.
 *  - Staff alerts: only people the staff directory still lists (it already leaves out banned logins, partners, clients and non-staff).
 *  - Marketing alerts: only people with an ACTIVE membership in THAT alert's team, the team LIVE, and the chat permission. A person in two teams never gets the
 *    wrong team's alerts; a paused person or a paused team gets nothing.
 *  - Calls (Antonio, 5 Nov 2026): he is told about a call ONLY when the call involves him. "Call moved" goes to everyone who works calls, so he is dropped from it
 *    unless the lead has a booking link with him (a call with Antonio); and when the client moves or cancels a call with Antonio he is added (today only the link's
 *    seller, Rocco in normal use, is told). Rocco and the setters keep exactly what the browser alert gives them. The owner is the member whose login email is the
 *    owner's work mailbox in the team's own time settings. Any doubt (no owner found, no lead, a failed read) means the owner is NOT told.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { listTeamMembers } from "@/lib/team/directory"
import { effectivePermissions, hasPermission } from "@/lib/marketing/permissions"
import { isTeamLive } from "@/lib/marketing/team-status"
import { getMarketingSetting } from "@/lib/marketing/settings"
import { loadPrefsAndRows } from "@/lib/marketing/time-prefs-server"

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

/** PURE. A client moved or cancelled a call WITH the owner: the owner is told too (the link's seller already is). */
export function withOwnerForCallAlert(kind: unknown, ids: readonly string[], ownerId: string | null): string[] {
  return kind === "marketing_call" && ownerId ? Array.from(new Set([...ids, ownerId])) : [...ids]
}

/** PURE. A call was moved by a person: the owner (and any other CRM admin) hears of it only if the call is one with him. */
export function withoutOwnerUnlessInvolved(kind: unknown, ids: readonly string[], ownerIds: readonly string[], involved: boolean): string[] {
  return kind === "marketing_lead_moved" && !involved ? ids.filter(id => !ownerIds.includes(id)) : [...ids]
}

/** The member who joins calls "with Antonio": the one whose login email is the owner's work mailbox in the team's time settings. null = unknown (then the owner is not told). */
async function ownerUserId(teamId: string): Promise<string | null> {
  try {
    const { prefs, rows } = await loadPrefsAndRows(teamId)
    const email = prefs.ownerClock.email?.trim().toLowerCase()
    if (!email) return null
    for (const m of rows.filter(r => r.status === "active")) {
      const u = await supabaseAdmin.auth.admin.getUserById(m.user_id)
      if (u?.data?.user?.email?.toLowerCase() === email) return m.user_id
    }
    return null
  } catch {
    return null
  }
}

/** Which of these people are CRM admins (the login's role). Used so the "only calls that involve you" rule holds even if the team's owner mailbox setting is missing. A failed lookup = not an admin. */
async function adminIdsAmong(ids: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const id of ids) {
    try {
      const u = await supabaseAdmin.auth.admin.getUserById(id)
      if (u?.data?.user?.app_metadata?.role === "admin") out.push(id)
    } catch { /* not an admin as far as we can tell */ }
  }
  return out
}

/** Does this lead have a booking link with the owner that was booked (or is being booked, or was cancelled)? That is what makes a call "a call with Antonio". A failed read = no. */
async function leadHasOwnerCall(teamId: string, leadId: string | null | undefined): Promise<boolean> {
  if (!leadId) return false
  try {
    const { count, error } = await db().from("marketing_joint_links").select("id", { count: "exact", head: true }).eq("team_id", teamId).eq("lead_id", leadId).in("status", ["booking", "booked", "cancelled"])
    return !error && (count ?? 0) > 0
  } catch {
    return false
  }
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
export async function marketingRecipients(teamId: string, ids: readonly string[], about: { kind?: unknown; leadId?: string | null } = {}): Promise<string[]> {
  if (!teamId || ids.length === 0) return []
  try {
    const needsOwner = about.kind === "marketing_call" || about.kind === "marketing_lead_moved"
    const owner = needsOwner ? await ownerUserId(teamId) : null
    const asked = withOwnerForCallAlert(about.kind, ids, owner)
    const [{ data: members, error: mErr }, { data: team, error: tErr }] = await Promise.all([
      db().from("marketing_team_members").select("user_id, member_role, status, bundle, permissions").eq("team_id", teamId).in("user_id", Array.from(new Set(asked))),
      db().from("marketing_teams").select("id, status").eq("id", teamId).maybeSingle(),
    ])
    if (mErr || tErr) return []
    const bundles = (await getMarketingSetting("permission_bundles", teamId)) as Record<string, string[]>
    const base = marketingRecipientsFrom((members ?? []) as MemberRow[], (team ?? null) as { status: unknown } | null, bundles ?? {})
    if (about.kind !== "marketing_lead_moved") return base
    // who counts as "the owner" here: the member of the owner mailbox AND every CRM admin among the recipients (a missing setting must not let a Rocco-only call through)
    const ownerIds = Array.from(new Set([...(owner ? [owner] : []), ...(await adminIdsAmong(base))]))
    const involved = ownerIds.some(id => base.includes(id)) ? await leadHasOwnerCall(teamId, about.leadId) : false
    return withoutOwnerUnlessInvolved(about.kind, base, ownerIds, involved)
  } catch {
    return []
  }
}
