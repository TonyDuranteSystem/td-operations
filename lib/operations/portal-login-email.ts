/**
 * Keep a client's PORTAL LOGIN email in sync with their CONTACT email.
 *
 * Why: the portal login (auth.users.email) is the credential the client signs in
 * with. The contact email (contacts.email) is what the CRM shows and where
 * client-facing mail goes. Historically only ONE UI path (the inline email field
 * on the contact/account detail) updated the login when the contact email
 * changed — so emails changed via the MCP tool, imports, or the core update
 * function left the login on the OLD address (the "Michele Cotti" drift). This
 * helper centralises the sync so EVERY contact-email change can call it.
 *
 * Safety:
 *  - Resolves the login by **contact_id** (the reliable link), never by email.
 *  - **Conflict guard:** if the new email already belongs to a DIFFERENT auth
 *    user, it does NOT change anything and returns `conflict` — the caller keeps
 *    the contact-email update but surfaces the flag (never silently merges
 *    identities or throws away the contact change).
 *  - Notifies the client of their new login (best-effort; a mail failure never
 *    fails the sync).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUsersByContactId, findAuthUserByEmail } from "@/lib/auth-admin-helpers"

export type LoginEmailSyncStatus =
  | "synced"
  | "no_login" // contact has no client portal login → nothing to sync
  | "no_change" // login already equals the new email
  | "conflict" // new email already belongs to another login → skipped
  | "error"

export interface LoginEmailSyncResult {
  status: LoginEmailSyncStatus
  oldEmail?: string
  newEmail?: string
  error?: string
}

export interface SyncPortalLoginEmailParams {
  contactId: string
  newEmail: string
  /** Send the client a "your login is now X" notice. Default true. */
  notify?: boolean
  /** Contact language for the notice ("Italian"/"it" → IT, else EN). */
  language?: string | null
  /** Full name for the notice greeting. */
  fullName?: string | null
}

export async function syncPortalLoginEmail(
  params: SyncPortalLoginEmailParams,
): Promise<LoginEmailSyncResult> {
  const { contactId, newEmail, notify = true, language, fullName } = params
  const target = (newEmail ?? "").trim()
  if (!contactId || !target) return { status: "error", error: "contactId and newEmail are required" }

  // 1. Find the client login by the contact link (NOT by email).
  const authUsers = await findAuthUsersByContactId(contactId)
  const clientUser = authUsers.find((u) => u.app_metadata?.role === "client")
  if (!clientUser) return { status: "no_login" }

  const oldEmail = clientUser.email ?? ""
  if (oldEmail.toLowerCase() === target.toLowerCase()) {
    return { status: "no_change", oldEmail, newEmail: target }
  }

  // 2. Conflict guard: is the target email already some OTHER auth user?
  const existing = await findAuthUserByEmail(target)
  if (existing && existing.id !== clientUser.id) {
    return { status: "conflict", oldEmail, newEmail: target }
  }

  // 3. Update the login email (admin API keeps users + identities consistent).
  const { error } = await supabaseAdmin.auth.admin.updateUserById(clientUser.id, {
    email: target,
    email_confirm: true,
  })
  if (error) return { status: "error", oldEmail, newEmail: target, error: error.message }

  // 4. Notify the client of the new login (best-effort).
  if (notify) {
    try {
      await sendLoginEmailChangedNotice({
        toEmail: target,
        previousEmail: oldEmail,
        fullName: fullName ?? null,
        language: language ?? null,
      })
    } catch (e) {
      console.error("[login-email-sync] notice failed:", e)
    }
  }

  return { status: "synced", oldEmail, newEmail: target }
}

/**
 * Bilingual "your portal login email changed" notice. Sent to the NEW address so
 * the client has the credential in hand. Password is unchanged.
 */
export async function sendLoginEmailChangedNotice(params: {
  toEmail: string
  previousEmail: string
  fullName: string | null
  language: string | null
}): Promise<void> {
  const { toEmail, fullName, language } = params
  const isIt = language === "it" || language === "Italian"
  const { gmailPost } = await import("@/lib/gmail")
  const { PORTAL_BASE_URL } = await import("@/lib/config")
  const loginUrl = `${PORTAL_BASE_URL}/portal/login`
  const name = fullName || (isIt ? "" : "there")

  const subject = isIt
    ? "Aggiornamento del tuo accesso al Portale — Tony Durante LLC"
    : "Your Portal login has been updated — Tony Durante LLC"
  const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`

  const html = isIt
    ? `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#3f3f46">
<p>Ciao ${name},</p>
<p>L'indirizzo email che usi per accedere al tuo Portale Clienti è stato aggiornato a:</p>
<p style="font-size:16px"><strong>${toEmail}</strong></p>
<p>Da ora accedi con questa email. <strong>La password non è cambiata.</strong> Se non ricordi la password, usa "Password dimenticata" nella pagina di accesso.</p>
<p><a href="${loginUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px">Accedi al Portale</a></p>
<p style="font-size:13px;color:#71717a">Se non hai richiesto questa modifica, contattaci subito.</p>
<p style="font-size:13px;color:#a1a1aa">Tony Durante LLC</p></div>`
    : `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#3f3f46">
<p>Hi ${name},</p>
<p>The email address you use to sign in to your Client Portal has been updated to:</p>
<p style="font-size:16px"><strong>${toEmail}</strong></p>
<p>Please sign in with this email from now on. <strong>Your password has not changed.</strong> If you don't remember it, use "Forgot password" on the login page.</p>
<p><a href="${loginUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px">Log in to Portal</a></p>
<p style="font-size:13px;color:#71717a">If you did not request this change, contact us right away.</p>
<p style="font-size:13px;color:#a1a1aa">Tony Durante LLC</p></div>`

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

  await gmailPost("/messages/send", { raw: Buffer.from(rawEmail).toString("base64url") })
}
