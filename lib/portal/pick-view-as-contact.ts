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
  full_name?: string | null
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

export interface ViewAsFallbackInput {
  /** The account's linked contacts (from account_contacts). */
  contacts: ViewAsCandidate[]
  /** The shared resolver's chosen signer, or null when it found nobody unambiguously. */
  resolvedSignerId: string | null
  /** Contact ids holding ANY client portal login (existence only). */
  loginHolders: ReadonlySet<string>
  /** Contact ids whose login exists but has never finished first-time setup. */
  needsSetupIds: ReadonlySet<string>
  /**
   * Contact ids who are CURRENT `members` rows for this account, or `null`
   * when the account has no members roster at all (SMLLC/legacy — every
   * linked contact is eligible, matching how those accounts always worked).
   * Bounds the fallback so a departed member's stale account_contacts link
   * (member removal does not clean that table up) can never be surfaced as a
   * substitute — bug-hunter finding, 2026-08-21.
   */
  currentMemberContactIds: ReadonlySet<string> | null
}

export interface ViewAsFallbackResult {
  contactId: string | null
  /** Set only when a DIFFERENT contact was substituted for the resolved signer. */
  note: string | null
}

/**
 * Pick who "View as client" should target, preferring a contact who has
 * actually FINISHED portal setup over one who merely has a login — and, when
 * substituting away from the account's resolved signer, explain why (KS Media
 * Consulting LLC, 2026-08-21: the resolved signer's account was stuck at
 * first-time setup even though a co-member had genuinely used the portal for
 * months; Antonio's explicit call was that View-as must still show something
 * in that case, with a note).
 *
 * Selection order:
 *   1. the resolved signer, if THEY have finished setup (unchanged best case)
 *   2. else any OTHER contact who is a CURRENT member (or any contact, if this
 *      account has no members roster) and has finished setup — chosen via the
 *      same deterministic `pickViewAsContactId` ordering, restricted to that
 *      subset
 *   3. else — nobody has finished setup — the pre-existing behavior: the
 *      resolved signer if they at least have a login, else the general
 *      fallback over every linked contact (unchanged, may return null)
 */
export function pickViewAsFallback(input: ViewAsFallbackInput): ViewAsFallbackResult {
  const { contacts, resolvedSignerId, loginHolders, needsSetupIds, currentMemberContactIds } = input

  const hasFinishedSetup = (id: string) => loginHolders.has(id) && !needsSetupIds.has(id)
  const isCurrentMember = (id: string) => currentMemberContactIds === null || currentMemberContactIds.has(id)

  if (resolvedSignerId && hasFinishedSetup(resolvedSignerId)) {
    return { contactId: resolvedSignerId, note: null }
  }

  const readyContacts = contacts.filter((c) => hasFinishedSetup(c.id) && isCurrentMember(c.id))
  if (readyContacts.length > 0) {
    const contactId = pickViewAsContactId(readyContacts, loginHolders)
    if (resolvedSignerId && contactId !== resolvedSignerId) {
      const signer = contacts.find((c) => c.id === resolvedSignerId)
      const shown = contacts.find((c) => c.id === contactId)
      const signerState = loginHolders.has(resolvedSignerId)
        ? "hasn't finished setting up their portal account yet"
        : 'doesn\'t have a portal login yet'
      return {
        contactId,
        note: `${signer?.full_name || 'The primary contact'} ${signerState} — showing you ${shown?.full_name || 'another member'}'s view instead, since they have.`,
      }
    }
    return { contactId, note: null }
  }

  if (resolvedSignerId && loginHolders.has(resolvedSignerId)) {
    // Nobody on the account has finished setup — land on the resolved
    // signer's own stuck screen, since there is genuinely nothing else to show.
    return { contactId: resolvedSignerId, note: null }
  }

  return { contactId: pickViewAsContactId(contacts, loginHolders), note: null }
}
