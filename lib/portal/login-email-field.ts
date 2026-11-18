/**
 * The "login email" box of the formation and onboarding wizards (dev job beb43385).
 *
 * WHY THIS EXISTS. The wizard's owner Email box used to be an ordinary, editable
 * field prefilled from the CRM contact email. The portal LOGIN email is a different
 * thing (the Supabase auth user), and the wizard submit wrote the typed value onto the
 * contact only. A client who typed another address therefore changed the CRM email
 * but not the login, and the two drifted apart.
 *
 * THE RULE. For a normal client (a login tied to a contact) the box shows the login
 * email, locked, with a big "read this" block. The submit forces the same value on the
 * server, whatever the browser sent. Team logins (no contact) keep the old box.
 *
 * Pure functions, no database, so every case is unit-tested.
 */

/** The wizard field this rule applies to. */
export const LOGIN_EMAIL_FIELD = 'owner_email'

/** The wizards whose Owner step carries that field (formation and onboarding share it). */
const LOGIN_EMAIL_WIZARDS: readonly string[] = ['formation', 'onboarding']

export function isLoginEmailWizard(wizardType: string | null | undefined): boolean {
  return !!wizardType && LOGIN_EMAIL_WIZARDS.includes(wizardType)
}

/**
 * The email the box is locked to, or null when the box stays as it always was.
 * Locked only for a wizard that has the box, for a login tied to a contact (a normal
 * client), and when the login really has an email.
 */
export function loginEmailLock(params: {
  wizardType: string | null | undefined
  contactId: string | null | undefined
  authEmail: string | null | undefined
}): string | null {
  if (!isLoginEmailWizard(params.wizardType)) return null
  if (!params.contactId) return null
  const email = (params.authEmail ?? '').trim()
  return email ? email : null
}

/** The form-data key that records "the client ticked I read it" for a must-read field. */
export function mustReadAckKey(fieldName: string): string {
  return `${fieldName}_read`
}

/**
 * Server side. Returns the submitted data with the owner email set to the login email
 * when the box is locked for this client; otherwise the same data untouched.
 * Never trusts what the browser sent for this one field.
 */
export function forceLoginEmail(params: {
  wizardType: string | null | undefined
  contactId: string | null | undefined
  authEmail: string | null | undefined
  data: Record<string, unknown>
}): Record<string, unknown> {
  const locked = loginEmailLock(params)
  if (!locked) return params.data
  return { ...params.data, [LOGIN_EMAIL_FIELD]: locked }
}
