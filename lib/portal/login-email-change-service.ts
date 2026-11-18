/**
 * Client changes their OWN portal login email — the server side (dev job beb43385, step 2).
 * Rules and numbers: lib/portal/login-email-change.ts. Emails: login-email-change-mail.ts. SERVER-ONLY.
 *
 * Order of a change, and why:
 *   start    limits → write the password attempt BEFORE checking it (so parallel guesses are counted) → check the
 *            password → the new email is nobody else's → one open request per login → code to the NEW address.
 *   confirm  count the code attempt in the database first (one function, row lock) → compare → claim the request
 *            (single use) → move the LOGIN → move the CONTACT email → note to the OLD address with the undo link.
 *            If the contact step fails the login is put back, so the two never drift apart.
 *   undo     the link proves the old mailbox is theirs → claim it (single use) → put the old email AND a new password
 *            on the login (a password change ends every open session, which is what kicks a stranger out) → contact back.
 *
 * Deliberately NOT syncPortalLoginEmail / updateContact(email): those run contact → login by contact id, would move the
 * login with no code, and would send a third "login updated" mail. Here the login is moved by its own id, from the session.
 * Measured on the sandbox (2026-11-18): an admin email change does not end the client's open session.
 */
import { randomUUID } from "crypto"
import { createClient as createBareClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserById } from "@/lib/auth-admin-helpers"
import { findEmailOwner } from "@/lib/portal/login-email-owner"
import { audit, greetingName, readContact } from "@/lib/portal/login-email-change-db"
import { localeFromLanguage } from "@/lib/locale"
import { setContactEmailForLoginChange } from "@/lib/operations/contact-login-email"
import { PORTAL_BASE_URL } from "@/lib/config"
import {
  LOGIN_EMAIL_CHANGE,
  type LoginIdentity,
  checkStartAllowed,
  checkUndo,
  cleanCode,
  countsAsPasswordAttempt,
  generateCode,
  generateUndoToken,
  hashSecret,
  hashesMatch,
  isFailure,
  isPlausibleEmail,
  isUuid,
  judgeAttempt,
  normalizeEmail,
  parseUndoToken,
  passwordAttemptAllowed,
  passwordProblem,
  resendWaitSeconds,
  withAltEmail,
  withoutAltEmail,
} from "@/lib/portal/login-email-change"
import { buildChangeCodeEmail, buildChangedNoticeEmail, sendLoginEmailChangeMail } from "@/lib/portal/login-email-change-mail"
import { alertLoginEmailUndone } from "@/lib/portal/login-email-change-alert"

// the table and its counter function are not in lib/database.types.ts yet (regenerate through the CI artifact), so the client is used untyped here
/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = { from: (t: string) => any; rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }> }
const db = () => supabaseAdmin as unknown as Db
const TABLE = "portal_login_email_changes"

function secretKey(): string {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!k) throw new Error("login-email-change: server secret missing")
  return `login-email-change:${k}`
}

/** Is this email already someone else's: another login (any kind), or another contact's email? Fails closed (throws) when it cannot tell. The rule itself lives in login-email-owner.ts (staff use it too). */
async function emailBelongsToSomeoneElse(email: string, me: { authUserId: string; contactId: string }): Promise<boolean> {
  return (await findEmailOwner(email, me)) !== null
}

/** Check the password on a THROWAWAY client (same as the staff change-password route): the caller's own session is never touched. */
async function checkPassword(email: string, password: string): Promise<"right" | "wrong" | "busy"> {
  const bare = createBareClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await bare.auth.signInWithPassword({ email, password })
  if (!error) return "right"
  return (error as { status?: number }).status === 429 ? "busy" : "wrong"
}

// ─── step 1: start ───────────────────────────────────────────────────────────────────────────────

export type StartResult =
  | { ok: true; requestId: string; resendAfterSeconds: number; codeValidMinutes: number }
  | { ok: false; code: "invalid_email" | "same_email" | "wrong_password" | "email_unavailable" | "too_many_passwords" | "too_many_starts" | "locked" | "mail_failed" | "busy" | "failed"; retryAfterSeconds?: number }

export async function startLoginEmailChange(params: { identity: LoginIdentity; newEmail: unknown; password: unknown; now?: Date }): Promise<StartResult> {
  const { identity } = params
  const now = params.now ?? new Date()
  const newEmail = normalizeEmail(params.newEmail)
  const password = typeof params.password === "string" ? params.password : ""
  try {
    if (!isPlausibleEmail(newEmail)) return { ok: false, code: "invalid_email" }
    if (newEmail === normalizeEmail(identity.currentEmail)) return { ok: false, code: "same_email" }
    if (!password) return { ok: false, code: "wrong_password" }

    // 1. limits from the rows kept for this login in the last hour (started changes, and any lock a wrong-code run left behind)
    const since = new Date(now.getTime() - LOGIN_EMAIL_CHANGE.startWindowMs).toISOString()
    const { data: recent, error: recentErr } = await db().from(TABLE).select("status, created_at, locked_until").eq("auth_user_id", identity.authUserId).gte("created_at", since).limit(500)
    if (recentErr) throw new Error(recentErr.message)
    const rows = (recent ?? []) as { status: string; created_at: string; locked_until: string | null }[]
    const allowed = checkStartAllowed({
      startTimes: rows.filter((r) => !countsAsPasswordAttempt(r.status)).map((r) => new Date(r.created_at)),
      lockedUntils: rows.filter((r) => r.locked_until).map((r) => new Date(r.locked_until as string)),
      now,
    })
    if (isFailure(allowed)) return { ok: false, code: allowed.reason, retryAfterSeconds: allowed.retryAfterSeconds }

    // 2. write the password attempt FIRST, then count: a flood of parallel guesses cannot all be judged
    const requestId = randomUUID()
    const { error: insErr } = await db().from(TABLE).insert({
      id: requestId, auth_user_id: identity.authUserId, contact_id: identity.contactId,
      old_email: identity.currentEmail, new_email: newEmail, status: "password_check", requested_by: "client",
    })
    if (insErr) throw new Error(insErr.message)
    const windowFrom = new Date(now.getTime() - LOGIN_EMAIL_CHANGE.lockMs).toISOString()
    const { data: attempts, error: cntErr } = await db().from(TABLE).select("created_at").eq("auth_user_id", identity.authUserId).in("status", ["password_check", "password_failed"]).gte("created_at", windowFrom).order("created_at", { ascending: true }).limit(500)
    if (cntErr) throw new Error(cntErr.message)
    const list = (attempts ?? []) as { created_at: string }[]
    if (!passwordAttemptAllowed(list.length)) {
      await db().from(TABLE).update({ status: "password_failed", updated_at: now.toISOString() }).eq("id", requestId)
      const oldest = new Date(list[0].created_at).getTime()
      return { ok: false, code: "too_many_passwords", retryAfterSeconds: Math.max(1, Math.ceil((oldest + LOGIN_EMAIL_CHANGE.lockMs - now.getTime()) / 1000)) }
    }

    // 3. the password
    const pw = await checkPassword(identity.currentEmail, password)
    if (pw !== "right") {
      await db().from(TABLE).update({ status: "password_failed", updated_at: now.toISOString() }).eq("id", requestId)
      return { ok: false, code: pw === "busy" ? "busy" : "wrong_password" }
    }

    // 4. the new email must be nobody else's (said after the password, so only someone who knows it can probe)
    if (await emailBelongsToSomeoneElse(newEmail, identity)) {
      await db().from(TABLE).update({ status: "cancelled", updated_at: now.toISOString() }).eq("id", requestId)
      await audit("portal_login_email_change_refused", "portal:self-serve", identity, "Login email change refused: that email is not available", { request_id: requestId, new_email: newEmail })
      return { ok: false, code: "email_unavailable" }
    }

    // 5. one open request per login: the older one is replaced, then this one becomes the open one
    await db().from(TABLE).update({ status: "cancelled", updated_at: now.toISOString() }).eq("auth_user_id", identity.authUserId).eq("status", "pending")
    const code = generateCode()
    const { data: promoted, error: proErr } = await db().from(TABLE).update({
      status: "pending", code_hash: hashSecret(secretKey(), requestId, code), code_sent_at: now.toISOString(),
      code_expires_at: new Date(now.getTime() + LOGIN_EMAIL_CHANGE.codeTtlMs).toISOString(), code_attempts: 0, code_sends: 1, updated_at: now.toISOString(),
    }).eq("id", requestId).eq("status", "password_check").select("id")
    if (proErr) {
      if ((proErr as { code?: string }).code === "23505") return { ok: false, code: "busy" } // two starts at the same moment: only one stays open
      throw new Error(proErr.message)
    }
    if (!promoted || promoted.length === 0) return { ok: false, code: "failed" }

    // 6. the code, to the NEW address
    const contact = await readContact(identity.contactId)
    const sent = await sendLoginEmailChangeMail({
      to: newEmail,
      email: buildChangeCodeEmail({ fullName: greetingName(contact), locale: localeFromLanguage(contact?.language), newEmail, code }),
    })
    if (sent === "send_failed") {
      await db().from(TABLE).update({ status: "cancelled", updated_at: now.toISOString() }).eq("id", requestId)
      return { ok: false, code: "mail_failed" }
    }
    await audit("portal_login_email_change_started", "portal:self-serve", identity, "Login email change started: code sent to the new address", { request_id: requestId, old_email: identity.currentEmail, new_email: newEmail, mail: sent })
    return { ok: true, requestId, resendAfterSeconds: Math.ceil(LOGIN_EMAIL_CHANGE.resendAfterMs / 1000), codeValidMinutes: Math.round(LOGIN_EMAIL_CHANGE.codeTtlMs / 60000) }
  } catch (e) {
    console.error("[login-email-change] start failed:", e)
    return { ok: false, code: "failed" }
  }
}

// ─── step 2: a new code ──────────────────────────────────────────────────────────────────────────

export type ResendResult =
  | { ok: true; resendAfterSeconds: number }
  | { ok: false; code: "not_found" | "wait" | "locked" | "too_many_codes" | "mail_failed" | "busy" | "failed"; retryAfterSeconds?: number }

export async function resendLoginEmailCode(params: { identity: LoginIdentity; requestId: unknown; now?: Date }): Promise<ResendResult> {
  const { identity } = params
  const now = params.now ?? new Date()
  try {
    if (!isUuid(params.requestId)) return { ok: false, code: "not_found" }
    const { data } = await db().from(TABLE).select("id, status, new_email, code_sent_at, code_sends, code_attempts, locked_until").eq("id", params.requestId).eq("auth_user_id", identity.authUserId).limit(1)
    const row = data && data[0]
    if (!row || row.status !== "pending") return { ok: false, code: "not_found" }
    if (row.locked_until && new Date(row.locked_until).getTime() > now.getTime()) return { ok: false, code: "locked", retryAfterSeconds: Math.ceil((new Date(row.locked_until).getTime() - now.getTime()) / 1000) }
    if (row.code_attempts >= LOGIN_EMAIL_CHANGE.maxCodeAttempts) return { ok: false, code: "locked" }
    if (row.code_sends >= LOGIN_EMAIL_CHANGE.maxCodeSends) return { ok: false, code: "too_many_codes" }
    const wait = resendWaitSeconds(new Date(row.code_sent_at), now)
    if (wait > 0) return { ok: false, code: "wait", retryAfterSeconds: wait }

    const code = generateCode()
    // compare-and-set on code_sends: two presses at the same moment send ONE mail
    const { data: upd, error } = await db().from(TABLE).update({
      code_hash: hashSecret(secretKey(), row.id, code), code_sent_at: now.toISOString(),
      code_expires_at: new Date(now.getTime() + LOGIN_EMAIL_CHANGE.codeTtlMs).toISOString(), code_sends: row.code_sends + 1, updated_at: now.toISOString(),
    }).eq("id", row.id).eq("status", "pending").eq("code_sends", row.code_sends).select("id")
    if (error) throw new Error(error.message)
    if (!upd || upd.length === 0) return { ok: false, code: "busy" }

    const contact = await readContact(identity.contactId)
    const sent = await sendLoginEmailChangeMail({
      to: row.new_email,
      email: buildChangeCodeEmail({ fullName: greetingName(contact), locale: localeFromLanguage(contact?.language), newEmail: row.new_email, code }),
    })
    if (sent === "send_failed") return { ok: false, code: "mail_failed" }
    return { ok: true, resendAfterSeconds: Math.ceil(LOGIN_EMAIL_CHANGE.resendAfterMs / 1000) }
  } catch (e) {
    console.error("[login-email-change] resend failed:", e)
    return { ok: false, code: "failed" }
  }
}

// ─── step 3: the code is entered, the login moves ────────────────────────────────────────────────

export type ConfirmResult =
  | { ok: true; oldEmail: string; newEmail: string; noticeSent: boolean }
  | { ok: false; code: "not_found" | "expired" | "locked" | "wrong_code" | "email_unavailable" | "failed"; attemptsLeft?: number; retryAfterSeconds?: number }

export async function confirmLoginEmailChange(params: { identity: LoginIdentity; requestId: unknown; code: unknown; now?: Date }): Promise<ConfirmResult> {
  const { identity } = params
  const now = params.now ?? new Date()
  try {
    if (!isUuid(params.requestId)) return { ok: false, code: "not_found" }
    const requestId = params.requestId

    // 1. count the attempt in the database FIRST (row lock), then judge it
    const { data, error } = await db().rpc("portal_login_email_take_attempt", {
      p_id: requestId, p_user: identity.authUserId, p_max: LOGIN_EMAIL_CHANGE.maxCodeAttempts, p_lock_ms: LOGIN_EMAIL_CHANGE.lockMs,
    })
    if (error) throw new Error(error.message)
    const r = Array.isArray(data) ? data[0] : data
    const typed = cleanCode(params.code)
    const matches = !!r && r.taken === true && typed.length === LOGIN_EMAIL_CHANGE.codeLength && hashesMatch(r.code_hash, hashSecret(secretKey(), requestId, typed))
    const verdict = judgeAttempt(
      r ? { taken: !!r.taken, status: r.status, codeExpiresAt: r.code_expires_at ? new Date(r.code_expires_at) : null, attempts: r.code_attempts, lockedUntil: r.locked_until ? new Date(r.locked_until) : null } : null,
      matches,
      now,
    )
    if (isFailure(verdict)) return { ok: false, code: verdict.reason === "wrong" ? "wrong_code" : verdict.reason, attemptsLeft: verdict.attemptsLeft, retryAfterSeconds: verdict.retryAfterSeconds }

    const oldEmail = identity.currentEmail
    const newEmail = normalizeEmail(r.new_email)
    if (normalizeEmail(oldEmail) !== normalizeEmail(r.old_email)) return { ok: false, code: "not_found" } // the login moved by another way since the request: start again

    // 2. nobody took the new email meanwhile
    if (await emailBelongsToSomeoneElse(newEmail, identity)) return { ok: false, code: "email_unavailable" }

    // 3. claim the request: single use, and only one of two parallel confirms goes on
    const { data: claimed, error: claimErr } = await db().from(TABLE).update({ status: "confirmed", confirmed_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", requestId).eq("status", "pending").select("id")
    if (claimErr) throw new Error(claimErr.message)
    if (!claimed || claimed.length === 0) return { ok: false, code: "not_found" }
    const release = () => db().from(TABLE).update({ status: "pending", confirmed_at: null, updated_at: new Date().toISOString() }).eq("id", requestId).eq("status", "confirmed")

    // 4. the LOGIN moves (by its own id)
    const { error: loginErr } = await supabaseAdmin.auth.admin.updateUserById(identity.authUserId, { email: newEmail, email_confirm: true })
    if (loginErr) {
      await release()
      console.error("[login-email-change] login update failed:", loginErr.message)
      return { ok: false, code: "failed" }
    }

    // 5. the CONTACT email follows; the old address stays on the contact as an alternate so mail from it is still matched
    const contact = await readContact(identity.contactId)
    const moved = await setContactEmailForLoginChange({ contactId: identity.contactId, email: newEmail, altEmails: withAltEmail(contact?.alt_emails, oldEmail) })
    const contactErr = moved.error ? { message: moved.error } : null
    if (contactErr) {
      // never leave the two apart: put the login back, reopen the request
      const { error: backErr } = await supabaseAdmin.auth.admin.updateUserById(identity.authUserId, { email: normalizeEmail(oldEmail), email_confirm: true })
      if (backErr) console.error("[login-email-change] COULD NOT PUT THE LOGIN BACK after a contact failure:", identity.authUserId, backErr.message)
      await release()
      console.error("[login-email-change] contact update failed:", contactErr.message)
      return { ok: false, code: "failed" }
    }

    // 6. the note to the OLD address, with the single-use "This wasn't me" link
    const undo = generateUndoToken(requestId)
    await db().from(TABLE).update({
      undo_token_hash: hashSecret(secretKey(), requestId, undo.secret),
      undo_expires_at: new Date(now.getTime() + LOGIN_EMAIL_CHANGE.undoTtlMs).toISOString(), updated_at: now.toISOString(),
    }).eq("id", requestId)
    const locale = localeFromLanguage(contact?.language)
    const sent = await sendLoginEmailChangeMail({
      to: oldEmail,
      email: buildChangedNoticeEmail({
        fullName: greetingName(contact), locale, oldEmail, newEmail, changedAt: now,
        undoUrl: `${PORTAL_BASE_URL}/portal/undo-email-change?token=${encodeURIComponent(undo.token)}&lang=${locale}`,
      }),
    })
    await audit("portal_login_email_changed", "portal:self-serve", identity, "Portal login email changed by the client (code confirmed)", { request_id: requestId, old_email: oldEmail, new_email: newEmail, notice: sent })
    return { ok: true, oldEmail, newEmail, noticeSent: sent !== "send_failed" }
  } catch (e) {
    console.error("[login-email-change] confirm failed:", e)
    return { ok: false, code: "failed" }
  }
}

// ─── the "This wasn't me" link (no login needed: the link proves the old mailbox is theirs) ───────

export type UndoPreview =
  | { ok: true; restoreEmail: string; locale: "en" | "it" }
  | { ok: false; reason: "invalid" | "used" | "expired" | "superseded" }

async function loadUndoRow(token: unknown, now: Date): Promise<
  | { ok: true; row: any; authUser: { id: string; email: string | null } }
  | { ok: false; reason: "invalid" | "used" | "expired" | "superseded" }
> {
  const parsed = parseUndoToken(token)
  if (!parsed) return { ok: false, reason: "invalid" }
  const { data } = await db().from(TABLE).select("id, auth_user_id, contact_id, old_email, new_email, status, undo_token_hash, undo_expires_at").eq("id", parsed.requestId).limit(1)
  const row = data && data[0]
  if (!row || !hashesMatch(row.undo_token_hash, hashSecret(secretKey(), row.id, parsed.secret))) return { ok: false, reason: "invalid" }
  const authUser = await findAuthUserById(row.auth_user_id)
  const check = checkUndo({ status: row.status, undoExpiresAt: row.undo_expires_at ? new Date(row.undo_expires_at) : null, currentLoginEmail: authUser?.email ?? "", changedTo: row.new_email, now })
  if (isFailure(check)) return { ok: false, reason: check.reason === "unknown" ? "invalid" : check.reason }
  return { ok: true, row, authUser: { id: row.auth_user_id, email: authUser?.email ?? null } }
}

export async function previewLoginEmailUndo(token: unknown, now: Date = new Date()): Promise<UndoPreview> {
  try {
    const found = await loadUndoRow(token, now)
    if (isFailure(found)) return { ok: false, reason: found.reason }
    const contact = await readContact(found.row.contact_id)
    return { ok: true, restoreEmail: found.row.old_email, locale: localeFromLanguage(contact?.language) }
  } catch (e) {
    console.error("[login-email-change] undo preview failed:", e)
    return { ok: false, reason: "invalid" }
  }
}

export type UndoResult =
  | { ok: true; email: string }
  | { ok: false; code: "invalid" | "used" | "expired" | "superseded" | "short" | "mismatch" | "email_unavailable" | "failed" }

export async function applyLoginEmailUndo(params: { token: unknown; password: unknown; repeat: unknown; now?: Date }): Promise<UndoResult> {
  const now = params.now ?? new Date()
  try {
    const problem = passwordProblem(params.password, params.repeat)
    if (problem) return { ok: false, code: problem }
    const found = await loadUndoRow(params.token, now)
    if (isFailure(found)) return { ok: false, code: found.reason }
    const { row } = found
    const oldEmail = normalizeEmail(row.old_email)
    const me = { authUserId: row.auth_user_id as string, contactId: row.contact_id as string }

    // the old address must still be free to take back
    if (await emailBelongsToSomeoneElse(oldEmail, me)) return { ok: false, code: "email_unavailable" }

    // claim the link: single use
    const { data: claimed, error: claimErr } = await db().from(TABLE).update({ status: "undone", undone_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", row.id).eq("status", "confirmed").select("id")
    if (claimErr) throw new Error(claimErr.message)
    if (!claimed || claimed.length === 0) return { ok: false, code: "used" }
    const release = () => db().from(TABLE).update({ status: "confirmed", undone_at: null, updated_at: new Date().toISOString() }).eq("id", row.id).eq("status", "undone")

    // the login gets its old email AND a new password in one call; a password change ends every open session, which puts a stranger out
    const { error: loginErr } = await supabaseAdmin.auth.admin.updateUserById(row.auth_user_id, { email: oldEmail, email_confirm: true, password: params.password as string })
    if (loginErr) {
      await release()
      console.error("[login-email-change] undo: login update failed:", loginErr.message)
      return { ok: false, code: "failed" }
    }

    const contact = await readContact(row.contact_id)
    const restored = await setContactEmailForLoginChange({ contactId: row.contact_id, email: oldEmail, altEmails: withoutAltEmail(contact?.alt_emails, oldEmail) })
    const contactErr = restored.error ? { message: restored.error } : null
    if (contactErr) console.error("[login-email-change] undo: contact email NOT restored (login already is):", row.contact_id, contactErr.message)

    await audit("portal_login_email_undone", "portal:self-serve", me, 'Portal login email put back by the client ("This wasn\'t me")', { request_id: row.id, restored_email: oldEmail, undone_email: row.new_email, contact_restored: !contactErr })
    await alertLoginEmailUndone({ fullName: contact?.full_name ?? null, contactId: row.contact_id, restoredEmail: oldEmail, undoneEmail: row.new_email })
    return { ok: true, email: oldEmail }
  } catch (e) {
    console.error("[login-email-change] undo failed:", e)
    return { ok: false, code: "failed" }
  }
}
