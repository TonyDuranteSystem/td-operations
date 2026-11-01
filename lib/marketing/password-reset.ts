/**
 * TD Marketing — choosing a new password with a one-time link (server; dev job 9aec66fa). Three doors, one table (`marketing_password_resets`, only the token's HASH is stored):
 *  - `createOwnerReset`: a team owner (or Antonio) makes a link for a person on his team and sends it himself;
 *  - `requestForgotPassword`: the person asks from the login page; the link is emailed ONLY to the address of his own marketing login, and the answer never says whether the address exists;
 *  - `completeReset`: the link + the new password. Every failure gives the same generic answer.
 * The rules are pure (reset-rules.ts). A reset can only ever change the password of a marketing login that is an active member of an active team; the second step (authenticator) is untouched,
 * so a stolen link alone still does not get anyone in. Sessions already open elsewhere are not ended by a reset.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { gmailPost } from "@/lib/gmail"
import { safeSend } from "@/lib/mcp/safe-send"
import { findMarketingAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { TRY_AGAIN_ERROR, WEAK_PASSWORD_ERROR, hashInviteToken, inviteUsable, isWeakPasswordError, newInviteToken, normalizeEmail, passwordProblem, plausibleToken } from "@/lib/marketing/invite-rules"
import { GENERIC_RESET_ERROR, eligibleForForgot, mayResetMember, overOwnerLimit, overSelfLimit, resetExpiry, resetUrl, type ResetKind } from "@/lib/marketing/reset-rules"
import { buildResetEmail } from "@/lib/marketing/reset-email"
import { buildInviteMime, firstNameFromEmail } from "@/lib/marketing/invite-email"
import { loadMember, mayManage, type Actor } from "@/lib/marketing/members"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the marketing tables are newer than the generated types
const db = () => supabaseAdmin as unknown as { from: (t: string) => any; auth: any }
type R<T = undefined> = { ok: boolean; error?: string; data?: T }
const fail = <T>(error: string): R<T> => ({ ok: false, error })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()
const NOT_READY = "Password reset is not ready yet (a database step is pending)."

type AuthUserLike = { id: string; email?: string | null; banned_until?: string | null; app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> }
const isBanned = (u: AuthUserLike) => !!u.banned_until && new Date(u.banned_until).getTime() > Date.now()
/** The table is missing (the database step has not been run there yet). */
const tableMissing = (err: { code?: string; message?: string } | null | undefined) => !!err && (err.code === "42P01" || err.code === "PGRST205" || /marketing_password_resets/.test(err.message ?? "") && /does not exist|schema cache/i.test(err.message ?? ""))

/** Cancels the login's earlier open link and stores a new one. Returns the raw token (shown once) and when it expires. */
async function issue(a: { teamId: string; userId: string; email: string; kind: ResetKind; requestedBy: string; requestedByUserId: string | null }): Promise<R<{ token: string; expiresAt: string }>> {
  const now = new Date()
  const cancel = await db().from("marketing_password_resets").update({ revoked_at: now.toISOString() }).eq("user_id", a.userId).is("used_at", null).is("revoked_at", null)
  if (cancel?.error) return fail(tableMissing(cancel.error) ? NOT_READY : TRY_AGAIN_ERROR)
  const token = newInviteToken()
  const expiresAt = resetExpiry(now, a.kind)
  const { error } = await db().from("marketing_password_resets").insert({
    team_id: a.teamId, user_id: a.userId, email_lower: a.email, token_hash: hashInviteToken(token), expires_at: expiresAt,
    requested_by: a.requestedBy, requested_by_user_id: a.requestedByUserId && UUID.test(a.requestedByUserId) ? a.requestedByUserId : null,
  })
  if (error) return fail(tableMissing(error) ? NOT_READY : TRY_AGAIN_ERROR)
  return { ok: true, data: { token, expiresAt } }
}

// ── an owner makes a link ────────────────────────────────────────────────────

export async function createOwnerReset(input: { teamId: string; userId: string; actor: Actor }): Promise<R<{ resetUrl: string; expiresAt: string; email: string }>> {
  if (!mayManage(input.actor)) return fail("You cannot manage the team.")
  if (!UUID.test(input.userId)) return fail("That person is not on the team.")
  const m = await loadMember(input.teamId, input.userId)
  const got = m ? await db().auth.admin.getUserById(input.userId) : null
  const u = got?.data?.user as AuthUserLike | undefined
  if (m && (got?.error || !u)) return fail("The login could not be checked. Please try again.")
  const verdict = mayResetMember({
    actorKind: input.actor.kind, actorUserId: input.actor.userId, targetUserId: input.userId,
    targetAuthRole: u?.app_metadata?.role, targetBanned: u ? isBanned(u) : false, targetMemberRole: m?.member_role ?? null, targetStatus: m?.status ?? null,
  })
  if (verdict.ok === false) return fail(verdict.error)
  const email = normalizeEmail(u?.email)
  if (!email) return fail("This login has no email address.")
  const { count, error: cErr } = await db().from("marketing_password_resets").select("id", { count: "exact", head: true }).eq("requested_by", input.actor.label).gte("created_at", hourAgo())
  if (cErr) return fail(tableMissing(cErr) ? NOT_READY : TRY_AGAIN_ERROR)
  if (overOwnerLimit(count ?? 0)) return fail("Too many reset links in the last hour. Please wait a little.")
  const issued = await issue({ teamId: input.teamId, userId: input.userId, email, kind: "owner", requestedBy: input.actor.label, requestedByUserId: input.actor.userId })
  if (issued.ok === false || !issued.data) return fail(issued.error ?? TRY_AGAIN_ERROR)
  return { ok: true, data: { resetUrl: resetUrl(APP_BASE_URL, issued.data.token), expiresAt: issued.data.expiresAt, email } }
}

// ── "Forgot password?" ───────────────────────────────────────────────────────

/**
 * The person asks for a link from the login page. Returns `valid: false` only when the text is not an email address at all; for every real-looking address the caller answers the same,
 * whether or not a link was sent (nothing is revealed about who has a login). Failures are logged, never shown.
 */
export async function requestForgotPassword(input: { email: unknown; lang?: unknown }): Promise<{ valid: boolean }> {
  const email = normalizeEmail(input.email)
  if (!email) return { valid: false }
  try {
    const user = (await findMarketingAuthUserByEmail(email)) as AuthUserLike | null
    if (!user) return { valid: true }
    const { data: members } = await db().from("marketing_team_members").select("team_id, status").eq("user_id", user.id).eq("status", "active")
    const teamIds = ((members ?? []) as Array<{ team_id: string }>).map(x => x.team_id)
    if (teamIds.length === 0) return { valid: true }
    const { data: teams } = await db().from("marketing_teams").select("id, status").in("id", teamIds)
    const team = ((teams ?? []) as Array<{ id: string; status: string }>).find(x => eligibleForForgot({ authRole: user.app_metadata?.role, banned: isBanned(user), memberStatus: "active", teamStatus: x.status }))
    if (!team) return { valid: true }
    const { count } = await db().from("marketing_password_resets").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("requested_by", "self").gte("created_at", hourAgo())
    if (overSelfLimit(count ?? 0)) return { valid: true }
    const issued = await issue({ teamId: team.id, userId: user.id, email, kind: "self", requestedBy: "self", requestedByUserId: null })
    if (issued.ok === false || !issued.data) { console.error("[marketing] forgot password: could not store a link:", issued.error); return { valid: true } }
    const fullName = typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name.trim().split(/\s+/)[0] : ""
    const mail = buildResetEmail({
      lang: input.lang === "en" ? "en" : "it", toName: fullName || firstNameFromEmail(email), link: resetUrl(APP_BASE_URL, issued.data.token), expiresAt: issued.data.expiresAt,
    })
    try {
      await safeSend({
        idempotencyCheck: async () => null,
        sendFn: async () => gmailPost("/messages/send", { raw: Buffer.from(buildInviteMime(email, mail)).toString("base64url") }),
        postSendSteps: [],
      })
    } catch (e) {
      console.error("[marketing] forgot password: the email could not be sent:", e instanceof Error ? e.message : String(e))
      await db().from("marketing_password_resets").update({ revoked_at: new Date().toISOString() }).eq("token_hash", hashInviteToken(issued.data.token))
    }
  } catch (e) {
    console.error("[marketing] forgot password failed:", e instanceof Error ? e.message : String(e))
  }
  return { valid: true }
}

// ── the link + the new password ──────────────────────────────────────────────

export async function completeReset(input: { token: unknown; password: unknown }): Promise<R<{ email: string }>> {
  if (!plausibleToken(input.token)) return fail(GENERIC_RESET_ERROR)
  const pw = passwordProblem(input.password)
  if (pw) return fail(pw)
  const { data: row } = await db().from("marketing_password_resets").select("*").eq("token_hash", hashInviteToken(input.token)).maybeSingle()
  if (!inviteUsable(row, new Date())) return fail(GENERIC_RESET_ERROR)
  // claim it first: of two people using the link together only one wins
  const { data: claimed } = await db().from("marketing_password_resets").update({ used_at: new Date().toISOString() }).eq("id", row.id).is("used_at", null).is("revoked_at", null).select("id")
  if (!Array.isArray(claimed) || claimed.length !== 1) return fail(GENERIC_RESET_ERROR)
  const revoke = async () => { await db().from("marketing_password_resets").update({ revoked_at: new Date().toISOString() }).eq("id", row.id) }
  // nothing was changed: give the link back so the same one can be tried again
  const unclaim = async () => { await db().from("marketing_password_resets").update({ used_at: null }).eq("id", row.id).is("revoked_at", null) }

  const got = await db().auth.admin.getUserById(row.user_id)
  const u = got?.data?.user as AuthUserLike | undefined
  if (got?.error || !u) {
    if ((got?.error as { status?: number } | undefined)?.status === 404) { await revoke(); return fail(GENERIC_RESET_ERROR) }
    await unclaim(); return fail(TRY_AGAIN_ERROR)
  }
  const { data: mem } = await db().from("marketing_team_members").select("status").eq("team_id", row.team_id).eq("user_id", row.user_id).maybeSingle()
  const { data: team } = await db().from("marketing_teams").select("status").eq("id", row.team_id).maybeSingle()
  const stillEligible = eligibleForForgot({ authRole: u.app_metadata?.role, banned: isBanned(u), memberStatus: mem?.status, teamStatus: team?.status }) && normalizeEmail(u.email) === row.email_lower
  if (!stillEligible) { await revoke(); return fail(GENERIC_RESET_ERROR) }

  const upd = await db().auth.admin.updateUserById(u.id, { password: input.password })
  if (upd?.error) {
    await unclaim()
    return fail(isWeakPasswordError(upd.error) ? WEAK_PASSWORD_ERROR : TRY_AGAIN_ERROR)
  }
  return { ok: true, data: { email: row.email_lower } }
}
