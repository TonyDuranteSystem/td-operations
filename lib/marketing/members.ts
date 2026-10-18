/**
 * TD Marketing — team members and invites (server; P1, dev job 9aec66fa).
 * Rules: an invite only ever creates a BRAND-NEW login (it never updates an existing one); every acceptance failure gives
 * the same generic answer; a grant can never exceed the granter's own access and nobody changes his own; removal bans the
 * login and bumps the token version; pausing a person takes effect on his next request (the guard reads the row every time).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { getMarketingSetting } from "@/lib/marketing/settings"
import { canGrant, validatePermissionList, MARKETING_PERMISSIONS } from "@/lib/marketing/permissions"
import {
  GENERIC_INVITE_ERROR, hashInviteToken, inviteExpiry, inviteUsable, newInviteToken, normalizeEmail, overInviteLimit, passwordProblem, plausibleToken,
} from "@/lib/marketing/invite-rules"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer tables than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any; auth: any }
type R<T = undefined> = { ok: boolean; error?: string; data?: T }
const fail = <T>(error: string): R<T> => ({ ok: false, error })

/** Who is acting. 'admin' is Antonio (owner of everything); an owner has every permission; a member only what he holds. */
export interface Actor {
  kind: "admin" | "owner" | "member"
  userId: string | null
  label: string
  permissions: readonly string[]
}

const grantParams = (a: Actor) => ({
  granterRole: (a.kind === "member" ? "member" : "owner") as "owner" | "member",
  granterPermissions: a.permissions,
  granterUserId: a.userId ?? "admin",
})

// ── invites ───────────────────────────────────────────────────────────────

export async function createInvite(input: {
  teamId: string; email: unknown; memberRole?: "owner" | "member"; bundle?: string | null; permissions?: unknown[]; actor: Actor
}): Promise<R<{ inviteUrl: string; expiresAt: string; email: string }>> {
  const email = normalizeEmail(input.email)
  if (!email) return fail("That email address does not look right.")
  const memberRole = input.memberRole ?? "member"
  if (memberRole === "owner" && input.actor.kind !== "admin") return fail("Only Antonio can add a team owner.")
  const { data: team } = await db().from("marketing_teams").select("id").eq("id", input.teamId).maybeSingle()
  if (!team) return fail("Team not found.")
  const bundles = (await getMarketingSetting("permission_bundles", input.teamId)) as Record<string, string[]>
  const bundle = input.bundle ?? null
  if (memberRole === "member" && (!bundle || !Object.prototype.hasOwnProperty.call(bundles, bundle))) return fail("Pick a role for this person.")
  const extra = input.permissions ?? []
  // what the person will hold must be something the granter may give: the bundle's permissions plus the extras
  const requested = [...(bundle ? (bundles[bundle] ?? []) : []), ...extra]
  const ceiling = (await getMarketingSetting("member_permission_ceiling", input.teamId)) as string[]
  const check = canGrant({ ...grantParams(input.actor), requested, ceiling, targetUserId: null })
  if (!check.ok) return fail(check.error ?? "Not allowed.")

  const since = new Date(Date.now() - 3600_000).toISOString()
  const { count } = await db().from("marketing_invites").select("id", { count: "exact", head: true }).eq("created_by", input.actor.label).gte("created_at", since)
  if (overInviteLimit(count ?? 0)) return fail("Too many invitations in the last hour. Try again later.")

  const now = new Date()
  // re-inviting the same email replaces the earlier open invite
  await db().from("marketing_invites").update({ revoked_at: now.toISOString() }).eq("team_id", input.teamId).eq("email_lower", email).is("used_at", null).is("revoked_at", null)
  const token = newInviteToken()
  const expiresAt = inviteExpiry(now)
  const { error } = await db().from("marketing_invites").insert({
    team_id: input.teamId, email_lower: email, member_role: memberRole, bundle, permissions: validatePermissionList(extra).value ?? [],
    token_hash: hashInviteToken(token), expires_at: expiresAt, created_by: input.actor.label,
  })
  if (error) return fail("The invitation could not be created. Please try again.")
  return { ok: true, data: { inviteUrl: `${APP_BASE_URL}/marketing/accept?token=${token}`, expiresAt, email } }
}

export async function acceptInvite(input: { token: unknown; password: unknown; fullName?: unknown }): Promise<R<{ email: string }>> {
  if (!plausibleToken(input.token)) return fail(GENERIC_INVITE_ERROR)
  const pw = passwordProblem(input.password)
  if (pw) return fail(pw)
  const hash = hashInviteToken(input.token)
  const { data: inv } = await db().from("marketing_invites").select("*").eq("token_hash", hash).maybeSingle()
  if (!inviteUsable(inv, new Date())) return fail(GENERIC_INVITE_ERROR)
  // claim it first: single use, and two simultaneous attempts cannot both win
  const { data: claimed } = await db().from("marketing_invites").update({ used_at: new Date().toISOString() })
    .eq("id", inv.id).is("used_at", null).is("revoked_at", null).select("id")
  if (!claimed || claimed.length === 0) return fail(GENERIC_INVITE_ERROR)

  const name = typeof input.fullName === "string" ? input.fullName.trim().slice(0, 120) : ""
  const created = await db().auth.admin.createUser({
    email: inv.email_lower, password: input.password, email_confirm: true,
    app_metadata: { role: "marketing" }, user_metadata: name ? { full_name: name } : {},
  })
  if (created.error || !created.data?.user) {
    // already a login with this email (client, staff, admin ...) or a refusal: say nothing specific, never touch the existing login
    await db().from("marketing_invites").update({ revoked_at: new Date().toISOString() }).eq("id", inv.id)
    return fail(GENERIC_INVITE_ERROR)
  }
  const { error: mErr } = await db().from("marketing_team_members").insert({
    team_id: inv.team_id, user_id: created.data.user.id, member_role: inv.member_role, bundle: inv.bundle, permissions: inv.permissions ?? [],
    status: "active", invited_by: inv.created_by, invited_at: inv.created_at, joined_at: new Date().toISOString(),
  })
  if (mErr) {
    await db().auth.admin.deleteUser(created.data.user.id)
    return fail(GENERIC_INVITE_ERROR)
  }
  return { ok: true, data: { email: inv.email_lower } }
}

// ── members ───────────────────────────────────────────────────────────────

export async function listMembers(teamId: string) {
  const { data } = await db().from("marketing_team_members").select("user_id, member_role, bundle, permissions, status, invited_at, joined_at, removed_at").eq("team_id", teamId).order("invited_at", { ascending: true })
  const rows = (data ?? []) as Array<{ user_id: string }>
  const out = []
  for (const r of rows) {
    const u = await db().auth.admin.getUserById(r.user_id)
    out.push({ ...r, email: u?.data?.user?.email ?? null, last_sign_in_at: u?.data?.user?.last_sign_in_at ?? null })
  }
  return out
}

async function loadMember(teamId: string, userId: string) {
  const { data } = await db().from("marketing_team_members").select("*").eq("team_id", teamId).eq("user_id", userId).maybeSingle()
  return data as { user_id: string; member_role: "owner" | "member"; status: string; token_version: number; bundle: string | null; permissions: string[] } | null
}

function mayManage(actor: Actor): boolean {
  return actor.kind !== "member" || actor.permissions.includes("team.manage")
}

export async function removeMember(input: { teamId: string; userId: string; actor: Actor }): Promise<R> {
  if (!mayManage(input.actor)) return fail("You cannot manage the team.")
  if (input.actor.userId && input.actor.userId === input.userId) return fail("You cannot remove yourself.")
  const m = await loadMember(input.teamId, input.userId)
  if (!m || m.status === "removed") return fail("That person is not on the team.")
  if (m.member_role === "owner" && input.actor.kind !== "admin") return fail("Only Antonio can remove a team owner.")
  const now = new Date().toISOString()
  const { error } = await db().from("marketing_team_members").update({ status: "removed", removed_at: now, removed_by: input.actor.label, token_version: (m.token_version ?? 1) + 1 })
    .eq("team_id", input.teamId).eq("user_id", input.userId)
  if (error) return fail("The change could not be saved. Please try again.")
  // end the login itself: the middleware refuses a banned login on its very next request
  await db().auth.admin.updateUserById(input.userId, { ban_duration: "876000h" })
  return { ok: true }
}

export async function setMemberPaused(input: { teamId: string; userId: string; paused: boolean; actor: Actor }): Promise<R> {
  if (!mayManage(input.actor)) return fail("You cannot manage the team.")
  if (input.actor.userId && input.actor.userId === input.userId) return fail("You cannot pause yourself.")
  const m = await loadMember(input.teamId, input.userId)
  if (!m || m.status === "removed") return fail("That person is not on the team.")
  if (m.member_role === "owner" && input.actor.kind !== "admin") return fail("Only Antonio can pause a team owner.")
  const { error } = await db().from("marketing_team_members").update({ status: input.paused ? "paused" : "active" }).eq("team_id", input.teamId).eq("user_id", input.userId)
  if (error) return fail("The change could not be saved. Please try again.")
  return { ok: true }
}

export async function updateMemberAccess(input: { teamId: string; userId: string; bundle?: string | null; permissions?: unknown[]; actor: Actor }): Promise<R> {
  if (!mayManage(input.actor)) return fail("You cannot manage the team.")
  const m = await loadMember(input.teamId, input.userId)
  if (!m || m.status === "removed") return fail("That person is not on the team.")
  if (m.member_role === "owner") return fail("A team owner already has every permission.")
  const bundles = (await getMarketingSetting("permission_bundles", input.teamId)) as Record<string, string[]>
  const bundle = input.bundle === undefined ? m.bundle : input.bundle
  if (bundle && !Object.prototype.hasOwnProperty.call(bundles, bundle)) return fail("Unknown role.")
  const extra = input.permissions === undefined ? m.permissions : input.permissions
  const ceiling = (await getMarketingSetting("member_permission_ceiling", input.teamId)) as string[]
  const check = canGrant({ ...grantParams(input.actor), requested: [...(bundle ? bundles[bundle] : []), ...extra], ceiling, targetUserId: input.userId })
  if (!check.ok) return fail(check.error ?? "Not allowed.")
  const { error } = await db().from("marketing_team_members").update({ bundle, permissions: validatePermissionList(extra).value ?? [] }).eq("team_id", input.teamId).eq("user_id", input.userId)
  if (error) return fail("The change could not be saved. Please try again.")
  return { ok: true }
}

export const ALL_PERMISSIONS = MARKETING_PERMISSIONS
