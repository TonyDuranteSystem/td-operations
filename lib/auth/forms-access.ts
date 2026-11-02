/**
 * Who may use the CRM "Forms" area besides administrators (dev job 6baa1bfc, Antonio 2026-11-02).
 *
 * The Forms area is the Forms page, the bank-application list behind it, and the two staff routes that page calls. It holds
 * applicants' answers and their passport / ID uploads, and lets the holder make, revoke and reset one-time links, so it was
 * administrators-only. Antonio named two staff logins that may use it too. It is a NAMED list, not the whole `team` role:
 * giving the role the area would hand it to every future staff login.
 *
 * ONE rule, used by all three locks that guard the area: the sidebar item (via canUseForms in lib/auth.ts), the page guard in
 * middleware.ts, and the two /api/bofa-intake-admin routes. A lock left out is a dead link for the person it was meant for —
 * the visitor is bounced home with no explanation — so never change one without the others.
 *
 * Dependency-free on purpose (only the staff-role allow-list): the middleware imports it too.
 * To add or remove a person, edit FORMS_ACCESS_EMAILS and nothing else.
 */

import { isStaffAuthRole } from "@/lib/team/workspace"

/** The staff logins (lower-case) that may use the Forms area although they are not administrators. */
export const FORMS_ACCESS_EMAILS: readonly string[] = ["luca@tonydurante.us", "support@tonydurante.us"]

/** The CRM pages that make up the Forms area (a path matches itself and everything under it). */
export const FORMS_AREA_PATHS: readonly string[] = ["/forms", "/bofa-intake"]

/** Is this URL path inside the Forms area? Matches on whole path segments: `/formation-form` is not `/forms`. */
export function isFormsAreaPath(pathname: string): boolean {
  return FORMS_AREA_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))
}

/**
 * Is this login one of the named people? Needs BOTH the listed email AND a staff role (admin or team), so a client, partner
 * or marketing login that happens to carry a listed address gets nothing. `role` must come from app_metadata, which only the
 * service role can write — never from user_metadata, which the account holder can edit.
 * Administrators are handled by the caller (isAdmin); this only answers for the named non-administrators.
 */
export function hasFormsAccess(email: string | null | undefined, role: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase()
  if (!e || !FORMS_ACCESS_EMAILS.includes(e)) return false
  return isStaffAuthRole(role)
}
