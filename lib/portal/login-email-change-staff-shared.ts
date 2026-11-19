/**
 * Small pieces shared by the CRM screens and the server for the STAFF change of a client's login email
 * (dev job beb43385, step 3). Client-safe: no server imports here.
 */

/**
 * The marker a CRM email box gets back when the contact HAS a portal login: the box must not change the contact
 * email alone (that would leave the login on the old address), so the screen opens "Change login email" instead.
 */
export const LOGIN_LINKED_ERROR = "login-email-use-change-dialog"

/** Plain message for a screen that cannot open the dialog (e.g. the marker reached a toast). */
export const LOGIN_LINKED_MESSAGE =
  "This client has a portal login. Use \"Change login email\" on the contact's Portal tab, so the login, the contact and both mailboxes are handled together."

export type StaffChangeCode =
  | "invalid_email"
  | "no_contact"
  | "no_login"
  | "unlinked_login"
  | "several_logins"
  | "same_email"
  | "email_taken"
  | "failed"

/** What the staff screen asks the server about a contact before it opens the dialog. */
export type StaffLoginLookupView =
  | { state: "linked"; loginEmail: string; contactEmail: string | null; contactName: string | null; suspended: boolean }
  | { state: "none" | "unlinked" | "several" | "no_contact"; message: string }
