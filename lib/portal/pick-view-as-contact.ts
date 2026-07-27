/**
 * Who should the account page's "View as client" button target?
 *
 * The old inline rule was `contacts.find(c => c.role === 'Owner') ?? contacts[0]`
 * and it carried three faults, all of which fired together on Nexo Agency LLC
 * (2026-07-27):
 *
 *   1. CASE. `account_contacts.role` is free text and production holds BOTH
 *      spellings (verified 2026-07-27: 264 'owner' rows vs 21 'Owner' rows).
 *      A strict `=== 'Owner'` matched the rare spelling and missed the common
 *      one.
 *   2. ORDER. The account page's contacts query had no ORDER BY, so the
 *      `?? contacts[0]` fallback picked an arbitrary row that could change
 *      between page loads.
 *   3. LOGIN. Nothing checked that the chosen contact actually HAS a portal
 *      login. The button's entire purpose is to open that person's portal, so
 *      a target without a login guarantees the click fails with "This client
 *      has no portal login" — exactly what happened on Nexo, whose only
 *      owner-role link is a contact with no auth user.
 *
 * Fault 3 is the decisive one: viewability is the button's precondition, so it
 * belongs IN the choice, not discovered after the click.
 *
 * Selection rule (deterministic — never positional):
 *   1. owner (case-insensitive) WITH a login
 *   2. any linked contact WITH a login, tie-broken by contact id
 *   3. null — the caller hides the button instead of rendering one that is
 *      guaranteed to error.
 */

export interface ViewAsCandidate {
  id: string
  role?: string | null
}

/** True when the junction role names the account owner, in any casing/padding. */
export function isOwnerRole(role: string | null | undefined): boolean {
  return (role ?? '').trim().toLowerCase() === 'owner'
}

/**
 * Pick the contact whose portal the "View as client" button should open.
 *
 * @param contacts            the account's linked contacts with their junction role
 * @param contactIdsWithLogin ids of contacts that own a CLIENT auth user
 * @returns the chosen contact id, or null when nobody on the account can be
 *          viewed (caller hides the button)
 */
export function pickViewAsContactId(
  contacts: ViewAsCandidate[],
  contactIdsWithLogin: ReadonlySet<string>,
): string | null {
  const viewable = contacts
    .filter((c) => c && typeof c.id === 'string' && c.id.length > 0)
    .filter((c) => contactIdsWithLogin.has(c.id))
    // Stable id sort so the same account always resolves the same person
    // regardless of the order Postgres returned the junction rows in.
    .sort((a, b) => a.id.localeCompare(b.id))

  if (viewable.length === 0) return null
  return (viewable.find((c) => isOwnerRole(c.role)) ?? viewable[0]).id
}
