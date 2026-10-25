/**
 * TD Marketing — team members and invites (server; P1, dev job 9aec66fa).
 * Rules: an invite only ever creates a BRAND-NEW login (it never updates an existing one); every acceptance failure gives
 * the same generic answer; a grant can never exceed the granter's own access and nobody changes his own; removal bans the
 * login and bumps the token version; pausing a person takes effect on his next request (the guard reads the row every time).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { getMarketingSetting } from "@/lib/marketing/settings"
import { canGrant, effectivePermissions, validatePermissionList, MARKETING_PERMISSIONS } from "@/lib/marketing/permissions"
import { findMarketingAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { isSecureAdmin } from "@/lib/auth"
import {
  GENERIC_INVITE_ERROR, TRY_AGAIN_ERROR, WEAK_PASSWORD_ERROR, hashInviteToken, inviteExpiry, inviteUsable, isEmailTakenError, isOrphanMarketingLogin,
  isWeakPasswordError, newInviteToken, normalizeEmail, overInviteLimit, passwordProblem, plausibleToken,
} from "@/lib/marketing/invite-rules"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- newer tables than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any; auth: any }
type R<T = undefined> = { ok: boolean; error?: string; data?: T }
const fail = <T>(error: string): R<T> => ({ ok: false, error })
/** The sender's login id for the invitations table (a uuid column): anything that is not a real uuid is stored as null. */
const asUuidOrNull = (v: string | null): string | null => (typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null)

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
  const extra = input.permissions ?? []
  // a person's access is their exact list of ticks; a role (bundle) is still accepted as a starting point for older callers
  if (memberRole === "member" && bundle && !Object.prototype.hasOwnProperty.call(bundles, bundle)) return fail("Unknown role.")
  if (memberRole === "member" && !bundle && (validatePermissionList(extra).value ?? []).length === 0) return fail("Choose what this person can do.")
  // what the person will hold must be something the granter may give: the bundle's permissions plus the extras
  const requested = [...(bundle ? (bundles[bundle] ?? []) : []), ...extra]
  const check = canGrant({ ...grantParams(input.actor), requested, targetUserId: null })
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
    token_hash: hashInviteToken(token), expires_at: expiresAt, created_by: input.actor.label, created_by_user_id: asUuidOrNull(input.actor.userId),
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

  const nowIso = () => new Date().toISOString()
  const revoke = async () => { await db().from("marketing_invites").update({ revoked_at: nowIso() }).eq("id", inv.id) }
  // nothing was created: give the invitation back so the same link can be tried again
  const unclaim = async () => { await db().from("marketing_invites").update({ used_at: null }).eq("id", inv.id).is("revoked_at", null) }

  // the person who sent the invitation must still have access: a removed or paused manager's invitations die with it
  if (inv.created_by_user_id) {
    const sender = await loadMember(inv.team_id, inv.created_by_user_id)
    if (sender && sender.status !== "active") { await revoke(); return fail(GENERIC_INVITE_ERROR) }
  }

  const name = typeof input.fullName === "string" ? input.fullName.trim().slice(0, 120) : ""
  let userId: string | null = null
  const created = await db().auth.admin.createUser({
    email: inv.email_lower, password: input.password, email_confirm: true,
    app_metadata: { role: "marketing" }, user_metadata: name ? { full_name: name } : {},
  })
  if (!created.error && created.data?.user) {
    userId = created.data.user.id
  } else if (isEmailTakenError(created.error)) {
    // A login with this email already exists. It is ours to finish ONLY when it is a marketing login that never got a team
    // membership (an earlier acceptance crashed between creating the login and saving the membership). A client, staff, admin or
    // partner login is never touched, and the answer stays generic so nobody can learn which emails belong to TD clients.
    const existing = await findMarketingAuthUserByEmail(inv.email_lower)
    if (existing) {
      const { count } = await db().from("marketing_team_members").select("user_id", { count: "exact", head: true }).eq("user_id", existing.id)
      if (isOrphanMarketingLogin(existing.app_metadata?.role, count ?? 0)) {
        const upd = await db().auth.admin.updateUserById(existing.id, {
          password: input.password, email_confirm: true, user_metadata: { ...(existing.user_metadata ?? {}), ...(name ? { full_name: name } : {}) },
        })
        if (!upd?.error) userId = existing.id
      }
    }
    if (!userId) { await revoke(); return fail(GENERIC_INVITE_ERROR) }
  } else {
    // a temporary failure, or a password the login system refuses: nothing was created
    await unclaim()
    return fail(isWeakPasswordError(created.error) ? WEAK_PASSWORD_ERROR : TRY_AGAIN_ERROR)
  }

  const { error: mErr } = await db().from("marketing_team_members").insert({
    team_id: inv.team_id, user_id: userId, member_role: inv.member_role, bundle: inv.bundle, permissions: inv.permissions ?? [],
    status: "active", invited_by: inv.created_by, invited_at: inv.created_at, joined_at: nowIso(),
  })
  if (mErr) {
    // undo the login we just made; if even that fails the login stays as an unfinished marketing login that the next acceptance finishes (above)
    await db().auth.admin.deleteUser(userId)
    await unclaim()
    return fail(TRY_AGAIN_ERROR)
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

function mayManage(actor: Actor): boolean {
  return actor.kind !== "member" || actor.permissions.includes("team.manage")
}

/** Invitations still open (not used, not revoked, not expired), newest first. The link itself is never stored, so it cannot be shown again. */
export async function listOpenInvites(teamId: string) {
  const { data } = await db().from("marketing_invites").select("id, email_lower, member_role, bundle, permissions, expires_at, created_by, created_at")
    .eq("team_id", teamId).is("used_at", null).is("revoked_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false })
  return (data ?? []) as Array<{ id: string; email_lower: string; member_role: "owner" | "member"; bundle: string | null; permissions: string[]; expires_at: string; created_by: string | null; created_at: string }>
}

export async function revokeInvite(input: { teamId: string; inviteId: string; actor: Actor }): Promise<R> {
  if (!mayManage(input.actor)) return fail("You cannot manage the team.")
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.inviteId)) return fail("That invitation was not found.")
  const { data: inv } = await db().from("marketing_invites").select("id, member_role, used_at, revoked_at").eq("team_id", input.teamId).eq("id", input.inviteId).maybeSingle()
  if (!inv || inv.used_at || inv.revoked_at) return fail("That invitation was not found.")
  if (inv.member_role === "owner" && input.actor.kind !== "admin") return fail("Only Antonio can cancel an owner invitation.")
  const { data, error } = await db().from("marketing_invites").update({ revoked_at: new Date().toISOString() })
    .eq("team_id", input.teamId).eq("id", input.inviteId).is("used_at", null).is("revoked_at", null).select("id")
  if (error) return fail("The change could not be saved. Please try again.")
  if (!data || data.length === 0) return fail("That invitation was not found.")
  return { ok: true }
}

async function loadMember(teamId: string, userId: string) {
  const { data } = await db().from("marketing_team_members").select("*").eq("team_id", teamId).eq("user_id", userId).maybeSingle()
  return data as { user_id: string; member_role: "owner" | "member"; status: string; token_version: number; bundle: string | null; permissions: string[] } | null
}


/**
 * Antonio (a CRM admin login) joins a team as its owner, directly: no invitation, because an invitation never touches an existing admin login. His login stays the same; the guard lets an admin who is
 * an active member work as that member. Admin only (the route checks). Safe to repeat: an existing row is made an active owner again.
 */
export async function addAdminAsOwner(input: { teamId: string; admin: { id: string; email: string | null } }): Promise<R<{ already: boolean }>> {
  const { data: team } = await db().from("marketing_teams").select("id").eq("id", input.teamId).maybeSingle()
  if (!team) return fail("Team not found.")
  const existing = await loadMember(input.teamId, input.admin.id)
  const now = new Date().toISOString()
  if (existing && existing.status === "active" && existing.member_role === "owner") return { ok: true, data: { already: true } }
  const label = input.admin.email ?? input.admin.id
  const { error } = existing
    ? await db().from("marketing_team_members").update({ member_role: "owner", status: "active", bundle: null, permissions: [], removed_at: null, removed_by: null }).eq("team_id", input.teamId).eq("user_id", input.admin.id)
    : await db().from("marketing_team_members").insert({ team_id: input.teamId, user_id: input.admin.id, member_role: "owner", bundle: null, permissions: [], status: "active", invited_by: label, invited_at: now, joined_at: now })
  if (error) return fail("Could not add you to the team. Please try again.")
  return { ok: true, data: { already: false } }
}

export async function removeMember(input: { teamId: string; userId: string; actor: Actor }): Promise<R> {
  if (!mayManage(input.actor)) return fail("You cannot manage the team.")
  if (input.actor.userId && input.actor.userId === input.userId) return fail("You cannot remove yourself.")
  const m = await loadMember(input.teamId, input.userId)
  if (!m || m.status === "removed") return fail("That person is not on the team.")
  if (m.member_role === "owner" && input.actor.kind !== "admin") return fail("Only Antonio can remove a team owner.")
  const now = new Date().toISOString()
  // end the login FIRST (the middleware refuses a banned login on its very next request). If that fails nothing has changed and the
  // person can simply try again; if saving the row fails afterwards the login is already closed, and trying again completes the record.
  // …but never ban a CRM ADMIN login (Antonio's own, when he is a member): removing him from a team must not lock him out of the CRM
  const target = await db().auth.admin.getUserById(input.userId)
  const isAdminLogin = isSecureAdmin(target?.data?.user ?? null)
  if (!isAdminLogin) {
    const ban = await db().auth.admin.updateUserById(input.userId, { ban_duration: "876000h" })
    if (ban?.error) return fail("The login could not be ended. Please try again.")
  }
  const { error } = await db().from("marketing_team_members").update({ status: "removed", removed_at: now, removed_by: input.actor.label, token_version: (m.token_version ?? 1) + 1 })
    .eq("team_id", input.teamId).eq("user_id", input.userId)
  if (error) return fail("The change could not be saved. Please try again.")
  // his unused invitations die with his access
  await db().from("marketing_invites").update({ revoked_at: now }).eq("team_id", input.teamId).eq("created_by_user_id", input.userId).is("used_at", null).is("revoked_at", null)
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
  if (input.permissions !== undefined && !Array.isArray(input.permissions)) return fail("Permissions must be a list.")
  const bundles = (await getMarketingSetting("permission_bundles", input.teamId)) as Record<string, string[]>
  const bundle = input.bundle === undefined ? m.bundle : input.bundle
  if (bundle && !Object.prototype.hasOwnProperty.call(bundles, bundle)) return fail("Unknown role.")
  const extra = input.permissions === undefined ? m.permissions : input.permissions
  // nobody is left with no access by accident: removing everything is what Remove or Pause is for
  if (!bundle && (validatePermissionList(extra).value ?? []).length === 0) return fail("Choose at least one thing this person can do, or use Pause or Remove.")
  // only what CHANGES has to be within the manager's own access: what the person already holds stays untouched, so a manager can still change an unrelated tick on a person
  // who holds something the manager lacks; but he can neither give nor take away what he does not hold himself
  const before = new Set<string>(effectivePermissions({ memberRole: "member", bundle: m.bundle, bundles, extra: m.permissions }))
  const after = new Set<string>([...(bundle ? bundles[bundle] : []), ...extra].map(String))
  const changed = [...Array.from(after).filter(p => !before.has(p)), ...Array.from(before).filter(p => !after.has(p))]
  const check = canGrant({ ...grantParams(input.actor), requested: changed, targetUserId: input.userId })
  if (!check.ok) return fail(check.error ?? "Not allowed.")
  const { error } = await db().from("marketing_team_members").update({ bundle, permissions: validatePermissionList(extra).value ?? [] }).eq("team_id", input.teamId).eq("user_id", input.userId)
  if (error) return fail("The change could not be saved. Please try again.")
  return { ok: true }
}

export const ALL_PERMISSIONS = MARKETING_PERMISSIONS
