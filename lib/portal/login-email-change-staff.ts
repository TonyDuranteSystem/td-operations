/**
 * STAFF changes a client's portal login email (dev job beb43385, step 3). SERVER-ONLY. Admin-only (the route checks).
 *
 * Antonio, 2026-11-18: staff change it RIGHT AWAY with no code, BOTH addresses are told, the same "this email belongs to
 * someone else" rule applies (staff are told who has it, the client never is), and the login and the contact email move
 * together. Rules and the clash check are shared with the client change (login-email-owner.ts, login-email-change.ts).
 *
 * Order, and why:
 *   find the login BY THE CONTACT ID (never by email: a drifted contact would be missed) → clash check → move the LOGIN
 *   by its own id → move the CONTACT (old address kept as an alternate) → note to the NEW address → note to the OLD address.
 *   If the contact step fails the login is put back, so the two never drift apart.
 *
 * Deliberately NOT written to portal_login_email_changes: that table backs the client's code, undo link and start limit;
 * a staff row there would eat the client's "5 starts an hour" and the staff note has no undo link (see the mail builder).
 * The audit row in action_log is the record.
 *
 * Measured on the sandbox (2026-11-18): an admin email change does NOT end the client's open sessions. If the reason is a
 * stolen login, staff also press "Send new password" (the screen says so).
 */
import type { User } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUsersByContactId, findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { localeFromLanguage } from "@/lib/locale"
import { PORTAL_BASE_URL } from "@/lib/config"
import { setContactEmailForLoginChange } from "@/lib/operations/contact-login-email"
import { isPlausibleEmail, isUuid, normalizeEmail, withAltEmail } from "@/lib/portal/login-email-change"
import { findEmailOwner, type EmailOwner } from "@/lib/portal/login-email-owner"
import { buildStaffChangedNewEmail, buildStaffChangedOldEmail, sendLoginEmailChangeMail } from "@/lib/portal/login-email-change-mail"
import { audit, greetingName, readContact, type ContactBits } from "@/lib/portal/login-email-change-db"
import type { StaffChangeCode, StaffLoginLookupView } from "@/lib/portal/login-email-change-staff-shared"

type MailResult = "sent" | "sandbox_blocked" | "send_failed"

export type StaffChangeResult =
  | { ok: true; oldEmail: string; newEmail: string; noticeToNew: MailResult; noticeToOld: MailResult }
  | { ok: false; code: StaffChangeCode; message: string }

/** What a contact has, for the dialog and for the change itself. `user` is the login found BY THE CONTACT ID. */
type Lookup =
  | { state: "linked"; user: User; loginEmail: string; contact: ContactBits }
  | { state: "none" | "unlinked" | "several" | "no_contact"; message: string }

const fail = (code: StaffChangeCode, message: string): StaffChangeResult => ({ ok: false, code, message })

const isClientLogin = (u: User) => (u.app_metadata as { role?: string } | undefined)?.role === "client"

async function lookup(contactId: string): Promise<Lookup> {
  const contact = await readContact(contactId)
  if (!contact) return { state: "no_contact", message: "Contact not found." }

  const logins = (await findAuthUsersByContactId(contactId)).filter(isClientLogin)
  if (logins.length > 1) {
    return { state: "several", message: `This contact has ${logins.length} client logins. Clean the duplicates up first (Portal tab), then change the email.` }
  }
  if (logins.length === 1) {
    const user = logins[0]
    const loginEmail = (user.email ?? "").trim()
    if (!loginEmail) return { state: "none", message: "This login has no email on it. Use \"Send new password\" or ask a developer." }
    return { state: "linked", user, loginEmail, contact }
  }

  // No login is tied to this contact. A login with the contact's email may still exist, tied to nobody (a team login):
  // never move that one from here.
  if (contact.email) {
    const byEmail = await findAuthUserByEmail(contact.email)
    if (byEmail && isClientLogin(byEmail)) {
      return {
        state: "unlinked",
        message: `A login for ${contact.email} exists but is not linked to this contact (a team-member login, or a login created by hand). It cannot be changed from here.`,
      }
    }
  }
  return { state: "none", message: "This contact has no client portal login yet." }
}

/** What the CRM screen shows before it opens the dialog. Never throws: a failure comes back as state "none" with the reason. */
export async function viewStaffLogin(contactId: unknown): Promise<StaffLoginLookupView> {
  if (!isUuid(contactId)) return { state: "no_contact", message: "Contact not found." }
  try {
    const found = await lookup(contactId)
    if (found.state !== "linked") return { state: found.state, message: found.message }
    const bannedUntil = (found.user as { banned_until?: string | null }).banned_until ?? null
    return {
      state: "linked",
      loginEmail: found.loginEmail,
      contactEmail: found.contact.email,
      contactName: found.contact.full_name,
      suspended: !!bannedUntil && new Date(bannedUntil) > new Date(),
    }
  } catch (e) {
    console.error("[login-email-change-staff] lookup failed:", e)
    return { state: "none", message: "Could not read the login right now. Try again in a moment." }
  }
}

/** Does this contact have a client portal login? Used by the CRM email boxes to decide whether to open the dialog. Fails SAFE: when it cannot tell, it says yes. */
export async function contactHasClientLogin(contactId: string): Promise<boolean> {
  try {
    return (await lookup(contactId)).state === "linked"
  } catch {
    return true
  }
}

/** A plain sentence for staff saying who already has the email. */
async function describeOwner(owner: EmailOwner): Promise<string> {
  const nameOf = async (contactId: string | null) => {
    if (!contactId) return null
    const { data } = await supabaseAdmin.from("contacts").select("full_name").eq("id", contactId).maybeSingle()
    return data?.full_name ?? null
  }
  if (owner.kind === "contact") {
    const name = await nameOf(owner.contactId)
    return `That email is already the ${owner.column === "email_2" ? "second email" : "email"} of ${name ?? "another contact"}. Change or remove it there first.`
  }
  const name = await nameOf(owner.contactId)
  if (name) return `That email is already the portal login of ${name}. A login email must belong to one person only.`
  return `That email is already a portal login (${owner.role ?? "no role"}) that is not linked to a client contact. A login email must belong to one person only.`
}

export async function staffChangeLoginEmail(params: { contactId: unknown; newEmail: unknown; actor: string; now?: Date }): Promise<StaffChangeResult> {
  const now = params.now ?? new Date()
  try {
    if (!isUuid(params.contactId)) return fail("no_contact", "Contact not found.")
    const contactId = params.contactId
    const newEmail = normalizeEmail(params.newEmail)
    if (!isPlausibleEmail(newEmail)) return fail("invalid_email", "That does not look like an email address.")

    const found = await lookup(contactId)
    if (found.state !== "linked") {
      const code: StaffChangeCode = found.state === "unlinked" ? "unlinked_login" : found.state === "several" ? "several_logins" : found.state === "no_contact" ? "no_contact" : "no_login"
      return fail(code, found.message)
    }
    const { user, loginEmail: oldEmail, contact } = found
    if (normalizeEmail(oldEmail) === newEmail) return fail("same_email", "That is already the login email.")

    // the same rule as the client change; staff are told WHO has it
    const owner = await findEmailOwner(newEmail, { authUserId: user.id, contactId })
    if (owner) return fail("email_taken", await describeOwner(owner))

    // 1. the LOGIN moves (by its own id)
    const { error: loginErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, { email: newEmail, email_confirm: true })
    if (loginErr) {
      console.error("[login-email-change-staff] login update failed:", loginErr.message)
      return fail("failed", "The login could not be changed, and nothing was changed. Try again, and tell a developer if it repeats.")
    }

    // 2. the CONTACT follows; both old addresses (the login's and, when it differed, the contact's own) stay as alternates so inbox matching still finds mail from them
    let alt = withAltEmail(contact.alt_emails, oldEmail)
    const priorContactEmail = normalizeEmail(contact.email)
    if (priorContactEmail && priorContactEmail !== newEmail) alt = withAltEmail(alt, priorContactEmail)
    let moved: { error: string | null }
    try {
      moved = await setContactEmailForLoginChange({ contactId, email: newEmail, altEmails: alt })
    } catch (e) {
      moved = { error: e instanceof Error ? e.message : String(e) } // a thrown error must roll the login back too
    }
    if (moved.error) {
      // never leave the two apart: put the login back
      const { error: backErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, { email: normalizeEmail(oldEmail), email_confirm: true })
      if (backErr) console.error("[login-email-change-staff] COULD NOT PUT THE LOGIN BACK after a contact failure:", user.id, backErr.message)
      console.error("[login-email-change-staff] contact update failed:", moved.error)
      return fail("failed", backErr
        ? "The login moved but the contact did not, and the login could not be put back. Tell a developer NOW."
        : "The contact could not be changed, so the login was left as it was. Nothing changed. Try again, and tell a developer if it repeats.")
    }

    // 3. both addresses are told, in the client's language
    const locale = localeFromLanguage(contact.language)
    const noticeToNew = await sendLoginEmailChangeMail({
      to: newEmail,
      email: buildStaffChangedNewEmail({ fullName: greetingName(contact), locale, oldEmail, newEmail, loginUrl: `${PORTAL_BASE_URL}/portal/login` }),
    })
    const noticeToOld = await sendLoginEmailChangeMail({
      to: oldEmail,
      email: buildStaffChangedOldEmail({ fullName: greetingName(contact), locale, oldEmail, newEmail, changedAt: now }),
    })

    await audit(
      "portal_login_email_changed",
      params.actor,
      { authUserId: user.id, contactId },
      "Portal login email changed by staff (no code)",
      { by: "staff", old_email: oldEmail, new_email: newEmail, prior_contact_email: contact.email, notice_to_new: noticeToNew, notice_to_old: noticeToOld },
    )
    return { ok: true, oldEmail, newEmail, noticeToNew, noticeToOld }
  } catch (e) {
    console.error("[login-email-change-staff] change failed:", e)
    return fail("failed", "Something went wrong and the change may not have completed. Check the Portal tab before trying again.")
  }
}
