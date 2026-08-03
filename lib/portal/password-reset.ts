/**
 * Portal self-serve password reset — OUR delivery, OUR audit trail.
 *
 * WHY THIS EXISTS (2026-08-02, client Chiara Fazzini):
 * Until now `/portal/forgot-password` called `supabase.auth.resetPasswordForEmail`
 * straight from the BROWSER. Two consequences, both of which bit a real client:
 *   1. The email arrived from "Supabase Auth" — plain, English, unbranded, from a
 *      sender no client has ever seen. Nothing like every other TD email. Easy for
 *      Gmail to file as spam and easy for a client not to recognise.
 *   2. The request never touched our servers, so NOTHING was recorded anywhere —
 *      not in Vercel logs, not in action_log. Verified 2026-08-02: a complete,
 *      successful self-serve reset leaves `auth.users.recovery_sent_at` NULL, no
 *      `auth.one_time_tokens` row and no `auth.audit_log_entries` row. So we could
 *      not answer the only question that mattered: "did the client actually try?"
 *
 * This module moves the SEND to our Gmail (same path as every other client email)
 * and writes an action_log row for EVERY attempt, matched or not. The token itself
 * is still minted by the auth provider via `admin.generateLink` — we deliberately
 * do NOT invent our own reset-token scheme. Same pattern already proven in this
 * repo by app/portal/view-as/route.ts, which mints a link server-side and mails
 * nothing.
 *
 * ⚠️ UNVERIFIED AT TIME OF WRITING: whether `generateLink({ type: 'recovery' })`
 * ALSO makes the provider send its own copy. If it does, the client receives two
 * emails (ours + the plain one). Must be confirmed on a live project BEFORE this
 * ships. The view-as precedent proves it for `magiclink` only.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { localeFromLanguage, type Locale } from "@/lib/locale"

/** Longest attempted address we will persist to action_log. The request route is
 *  unauthenticated, so the submitted string is attacker-controlled — cap it. */
export const MAX_LOGGED_EMAIL_LENGTH = 254

/**
 * Canonical normalization for a submitted reset address.
 * Trim + lowercase, matching findAuthUserByEmail's internal normalization and
 * the login page. Pure — normalize BEFORE looking up, logging or rate-keying so
 * all three agree on what "the same address" means.
 */
export function normalizeResetEmail(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase()
}

/** Cap an attempted address before it is persisted. Pure. */
export function truncateForLog(email: string): string {
  return email.slice(0, MAX_LOGGED_EMAIL_LENGTH)
}

export interface ResetEmailContent {
  subject: string
  html: string
}

/**
 * Bilingual, TD-branded reset email. Pure — no IO, so the copy and the link
 * placement are unit-testable without a mail server.
 *
 * Mirrors the shape of sendLoginEmailChangedNotice in
 * lib/operations/portal-login-email.ts so the client sees a consistent sender
 * and layout across every portal email.
 */
export function buildResetEmailContent(params: {
  fullName: string | null
  locale: Locale
  resetUrl: string
}): ResetEmailContent {
  const { fullName, locale, resetUrl } = params
  const isIt = locale === "it"
  const name = fullName || (isIt ? "" : "there")

  const subject = isIt
    ? "Reimposta la password del Portale — Tony Durante LLC"
    : "Reset your Portal password — Tony Durante LLC"

  const html = isIt
    ? `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#3f3f46">
<p>Ciao ${name},</p>
<p>Hai chiesto di reimpostare la password del tuo Portale Clienti. Clicca il pulsante qui sotto per sceglierne una nuova:</p>
<p><a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px">Reimposta la password</a></p>
<p style="font-size:13px;color:#71717a">Il link scade dopo un'ora e puo' essere usato una sola volta. Se non hai richiesto tu il cambio password, ignora questa email: la tua password resta invariata.</p>
<p style="font-size:13px;color:#a1a1aa">Tony Durante LLC</p></div>`
    : `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#3f3f46">
<p>Hi ${name},</p>
<p>You asked to reset your Client Portal password. Click the button below to choose a new one:</p>
<p><a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px">Reset my password</a></p>
<p style="font-size:13px;color:#71717a">This link expires after one hour and can only be used once. If you did not ask for a password reset, ignore this email — your password stays unchanged.</p>
<p style="font-size:13px;color:#a1a1aa">Tony Durante LLC</p></div>`

  return { subject, html }
}

/** Outcome of one reset attempt. NEVER returned to the client — the route always
 *  answers neutrally so an outsider cannot enumerate which addresses have logins.
 *  This is for the audit row and for staff diagnosis only. */
export type ResetAttemptOutcome =
  | "sent"
  | "no_account"
  | "mint_failed"
  | "send_failed"
  | "sandbox_blocked"

export interface ResetAttemptResult {
  outcome: ResetAttemptOutcome
  /** Present only when an auth user matched. */
  authUserId?: string
  contactId?: string
}

/**
 * Run one password-reset attempt end to end.
 *
 * ALWAYS resolves (never throws to the caller) so the route can answer neutrally
 * whatever happened. The real outcome goes to action_log, which is the entire
 * point of this module: staff can now answer "did the client try, and did the
 * mail actually leave?".
 */
export async function runPasswordResetAttempt(params: {
  rawEmail: string
  portalBaseUrl: string
  /** Coarse request origin for the audit row (IP or rate-limit key). */
  requestKey?: string
}): Promise<ResetAttemptResult> {
  const { rawEmail, portalBaseUrl, requestKey } = params
  const email = normalizeResetEmail(rawEmail)

  let result: ResetAttemptResult = { outcome: "no_account" }

  try {
    const authUser = email ? await findAuthUserByEmail(email) : null

    if (authUser?.email) {
      // Look up the contact for the name + language. A missing contact is NOT a
      // failure — teammate logins have no contacts row (lib/portal/team/provision.ts)
      // and must still be able to reset. Fall back to English + no name.
      // NOT maybeSingle(): the same email legitimately appears on more than one
      // contact row (found in sandbox 2026-08-02 — tdtest@tonydurante.us is on
      // two contacts, one Italian and one English). maybeSingle() ERRORS on a
      // multi-row match and hands back null, which would silently downgrade a
      // duplicated Italian client to an English email — the exact class of bug
      // this whole job is about. Take the oldest row deterministically instead.
      const { data: contacts } = await supabaseAdmin
        .from("contacts")
        .select("id, full_name, language")
        .ilike("email", authUser.email)
        .order("created_at", { ascending: true })
        .limit(1)
      const contact = contacts?.[0] ?? null

      const locale = localeFromLanguage(contact?.language ?? null)

      const { data: link, error: linkErr } =
        await supabaseAdmin.auth.admin.generateLink({
          type: "recovery",
          email: authUser.email,
          // Carry the client's language on the link. The reset page is reached
          // LOGGED OUT, where the portal has no LocaleProvider and getLocale()
          // needs a session — so without this marker an Italian client always
          // lands on an English "New Password" screen. We mint the link, so we
          // are the only place that still knows who they are.
          options: {
            redirectTo: `${portalBaseUrl}/portal/reset-password?lang=${locale}`,
          },
        })

      const actionLink = link?.properties?.action_link
      if (linkErr || !actionLink) {
        result = {
          outcome: "mint_failed",
          authUserId: authUser.id,
          contactId: contact?.id,
        }
      } else {
        const { subject, html } = buildResetEmailContent({
          fullName: contact?.full_name ?? null,
          locale,
          resetUrl: actionLink,
        })
        const sent = await sendResetEmail({
          toEmail: authUser.email,
          subject,
          html,
        })
        result = {
          outcome: sent,
          authUserId: authUser.id,
          contactId: contact?.id,
        }
      }
    }
  } catch (err) {
    console.error("[password-reset] attempt failed:", err)
    result = { outcome: "send_failed" }
  }

  // Audit EVERY attempt, matched or not. Best-effort: a logging failure must
  // never change what the client sees.
  try {
    await supabaseAdmin.from("action_log").insert({
      actor: "portal:self-serve",
      action_type: "portal_password_reset_requested",
      table_name: "auth.users",
      record_id: result.authUserId ?? null,
      contact_id: result.contactId ?? null,
      summary: `Portal password reset requested (${result.outcome})`,
      details: {
        attempted_email: truncateForLog(email),
        outcome: result.outcome,
        matched: Boolean(result.authUserId),
        request_key: requestKey ?? null,
      },
    })
  } catch (err) {
    console.error("[password-reset] audit log failed:", err)
  }

  return result
}

/**
 * Send through OUR Gmail, exactly like every other client email.
 *
 * Returns "sandbox_blocked" rather than "sent" when SANDBOX_MODE short-circuits
 * the send (lib/gmail.ts:142) — never derive "we emailed the client" from
 * "gmailPost did not throw", or the audit row lies in the one environment where
 * we do our QA.
 */
async function sendResetEmail(params: {
  toEmail: string
  subject: string
  html: string
}): Promise<"sent" | "send_failed" | "sandbox_blocked"> {
  const { toEmail, subject, html } = params
  try {
    const { gmailPost } = await import("@/lib/gmail")
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
    const boundary = `boundary_${Buffer.from(toEmail).toString("hex").slice(0, 12)}`
    const rawEmail = [
      "From: Tony Durante <support@tonydurante.us>",
      `To: ${toEmail}`,
      `Subject: ${encodedSubject}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(html).toString("base64"),
      `--${boundary}--`,
    ].join("\r\n")

    const res = (await gmailPost("/messages/send", {
      raw: Buffer.from(rawEmail).toString("base64url"),
    })) as { sandbox?: boolean } | null

    return res?.sandbox ? "sandbox_blocked" : "sent"
  } catch (err) {
    console.error("[password-reset] gmail send failed:", err)
    return "send_failed"
  }
}
