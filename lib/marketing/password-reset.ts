/**
 * TD Marketing — choosing a new password with a one-time link (server; dev job 9aec66fa). Three doors, one table (`marketing_password_resets`, only the token's HASH is stored):
 *  - `createOwnerReset`: a team owner (or Antonio) makes a link for a person on his team and sends it himself;
 *  - `requestForgotPassword`: the person asks from the login page; the link is emailed ONLY to the address of his own marketing login, and the answer never says whether the address exists;
 *  - `completeReset`: the link + the new password. Every failure gives the same generic answer.
 * The rules are pure (reset-rules.ts). A reset can only ever change the password of a marketing login that is an active member of an active team; the second step (authenticator) is untouched,
 * so a stolen link alone still does not get anyone in. Changing the password through the login system ends EVERY session that login has open (measured on the sandbox: the old access token and
 * refresh token are refused at once), and the same call bumps the "remember this device" version, so the next sign-in asks for the code again on every device.
 * Forgot-password problems (nothing could be sent, the database could not be read) are told to Antonio in the team chat (reset-alert.ts) - the person only ever sees the generic answer.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { gmailPost } from "@/lib/gmail"
import { safeSend } from "@/lib/mcp/safe-send"
import { findMarketingAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { TRY_AGAIN_ERROR, WEAK_PASSWORD_ERROR, hashInviteToken, inviteUsable, isWeakPasswordError, newInviteToken, normalizeEmail, passwordProblem, plausibleToken } from "@/lib/marketing/invite-rules"
import { GENERIC_RESET_ERROR, eligibleForForgot, mayResetMember, openOwnerLink, overOwnerLimit, overSelfLimit, resetExpiry, resetUrl, type ResetKind } from "@/lib/marketing/reset-rules"
import { buildResetEmail } from "@/lib/marketing/reset-email"
import { buildInviteMime, firstNameFromEmail } from "@/lib/marketing/invite-email"
import { loadMember, mayManage, type Actor } from "@/lib/marketing/members"
import { alertForgotProblem } from "@/lib/marketing/reset-alert"

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
 * whether or not a link was sent (nothing is revealed about who has a login). Problems are never shown to the person: they are logged AND told to Antonio (reset-alert.ts).
 * A link made by a team owner that is still open is NOT replaced by this request (there is only ever one open link per login), and an email that could not be sent is deleted, not kept,
 * so a failed send does not use up the person's three requests an hour.
 */
export async function requestForgotPassword(input: { email: unknown; lang?: unknown }): Promise<{ valid: boolean }> {
  const email = normalizeEmail(input.email)
  if (!email) return { valid: false }
  const problem = async (reason: string) => { console.error("[marketing] forgot password:", reason); await alertForgotProblem(email, reason) }
  try {
    const user = (await findMarketingAuthUserByEmail(email)) as AuthUserLike | null
    if (!user) return { valid: true }
    const { data: members, error: memErr } = await db().from("marketing_team_members").select("team_id, status").eq("user_id", user.id).eq("status", "active")
    if (memErr) { await problem("the team could not be read"); return { valid: true } }
    const teamIds = ((members ?? []) as Array<{ team_id: string }>).map(x => x.team_id)
    if (teamIds.length === 0) return { valid: true }
    const { data: teams, error: teamErr } = await db().from("marketing_teams").select("id, status").in("id", teamIds)
    if (teamErr) { await problem("the team could not be read"); return { valid: true } }
    const team = ((teams ?? []) as Array<{ id: string; status: string }>).find(x => eligibleForForgot({ authRole: user.app_metadata?.role, banned: isBanned(user), memberStatus: "active", teamStatus: x.status }))
    if (!team) return { valid: true }
    const { data: open, error: openErr } = await db().from("marketing_password_resets").select("requested_by, used_at, revoked_at, expires_at").eq("user_id", user.id).is("used_at", null).is("revoked_at", null)
    if (openErr) { await problem(tableMissing(openErr) ? NOT_READY : "the earlier link could not be checked"); return { valid: true } }
    if (openOwnerLink((open ?? []) as Array<{ requested_by: string; used_at: string | null; revoked_at: string | null; expires_at: string }>, new Date())) return { valid: true }
    const { count, error: countErr } = await db().from("marketing_password_resets").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("requested_by", "self").gte("created_at", hourAgo())
    if (countErr) { await problem("the earlier requests could not be counted"); return { valid: true } }
    if (overSelfLimit(count ?? 0)) return { valid: true }
    const issued = await issue({ teamId: team.id, userId: user.id, email, kind: "self", requestedBy: "self", requestedByUserId: null })
    if (issued.ok === false || !issued.data) { await problem(`the link could not be stored: ${issued.error ?? "unknown"}`); return { valid: true } }
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
      // nothing was delivered and nobody holds the link: remove it (it must not count as a request); cancel it if it cannot be removed
      const gone = await db().from("marketing_password_resets").delete().eq("token_hash", hashInviteToken(issued.data.token))
      if (gone?.error) await db().from("marketing_password_resets").update({ revoked_at: new Date().toISOString() }).eq("token_hash", hashInviteToken(issued.data.token))
      await problem(`the email could not be sent: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`)
    }
  } catch (e) {
    await problem(`unexpected error: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`)
  }
  return { valid: true }
}

// ── the link + the new password ──────────────────────────────────────────────

export async function completeReset(input: { token: unknown; password: unknown }): Promise<R<{ email: string }>> {
  if (!plausibleToken(input.token)) return fail(GENERIC_RESET_ERROR)
  const pw = passwordProblem(input.password)
  if (pw) return fail(pw)
  const { data: row, error: rowErr } = await db().from("marketing_password_resets").select("*").eq("token_hash", hashInviteToken(input.token)).maybeSingle()
  if (rowErr) return fail(TRY_AGAIN_ERROR) // could not read: nothing was touched, the same link can be tried again
  if (!inviteUsable(row, new Date())) return fail(GENERIC_RESET_ERROR)
  // claim it first: of two people using the link together only one wins
  const { data: claimed } = await db().from("marketing_password_resets").update({ used_at: new Date().toISOString() }).eq("id", row.id).is("used_at", null).is("revoked_at", null).select("id")
  if (!Array.isArray(claimed) || claimed.length !== 1) return fail(GENERIC_RESET_ERROR)
  const revoke = async () => { await db().from("marketing_password_resets").update({ revoked_at: new Date().toISOString() }).eq("id", row.id) }
  // nothing was changed: give the link back so the same one can be tried again. If it cannot be given back it is dead, and the person must be told that (not "try again").
  const unclaim = async (): Promise<boolean> => {
    const back = await db().from("marketing_password_resets").update({ used_at: null }).eq("id", row.id).is("revoked_at", null)
    if (back?.error) { console.error("[marketing] reset: could not give the link back:", back.error.message ?? back.error.code); return false }
    return true
  }
  const retry = async (msg: string): Promise<R<{ email: string }>> => fail((await unclaim()) ? msg : GENERIC_RESET_ERROR)

  const got = await db().auth.admin.getUserById(row.user_id)
  const u = got?.data?.user as AuthUserLike | undefined
  if (got?.error || !u) {
    if ((got?.error as { status?: number } | undefined)?.status === 404) { await revoke(); return fail(GENERIC_RESET_ERROR) }
    return retry(TRY_AGAIN_ERROR)
  }
  const [memRes, teamRes] = await Promise.all([
    db().from("marketing_team_members").select("status").eq("team_id", row.team_id).eq("user_id", row.user_id).maybeSingle(),
    db().from("marketing_teams").select("status").eq("id", row.team_id).maybeSingle(),
  ])
  // a failed READ is not "no longer eligible": do not cancel a good link because the database hiccuped
  if (memRes?.error || teamRes?.error) return retry(TRY_AGAIN_ERROR)
  const stillEligible = eligibleForForgot({ authRole: u.app_metadata?.role, banned: isBanned(u), memberStatus: memRes?.data?.status, teamStatus: teamRes?.data?.status }) && normalizeEmail(u.email) === row.email_lower
  if (!stillEligible) { await revoke(); return fail(GENERIC_RESET_ERROR) }

  // One call: the new password (this also ends every session the login has open) and a bumped "remember this device" version (the next sign-in asks for the code again everywhere).
  const rd = u.app_metadata?.mfa_rd_version
  const upd = await db().auth.admin.updateUserById(u.id, { password: input.password, app_metadata: { ...u.app_metadata, mfa_rd_version: (typeof rd === "number" ? rd : 0) + 1 } })
  if (upd?.error) return retry(isWeakPasswordError(upd.error) ? WEAK_PASSWORD_ERROR : TRY_AGAIN_ERROR)
  return { ok: true, data: { email: row.email_lower } }
}
