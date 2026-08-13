/**
 * Who the owner of record is, for a company with no member roster.
 *
 * ── WHAT THIS FILE NO LONGER DOES ──
 *
 * It used to hold the machinery for letting a sole owner TYPE their address on the
 * Generate Documents screen: a splitter that reversed a stored one-line address
 * back into five form fields, and a permission check for who could author it. Both
 * are DELETED and must not come back. The splitter was the defect — a joined
 * address is lossy, splitting it guessed wrong for 35 of the 271 contacts with an
 * address, and the wrong guess was written back over the client's contact record,
 * silently erasing city, state, postal code and country.
 *
 * NOTHING on the Operating Agreement screen is editable, for any company shape.
 *
 * ── WHY THE ANSWER BELOW IS A RESULT AND NOT A STRING ──
 *
 * The first attempt at removing the old "otherwise take the first link" fallback
 * returned null when no role matched. That looked safe and was not: the screen
 * rendered a member named "N/A" while the route stored the LOGGED-IN person's name,
 * so the previewed document and the signed document disagreed about who owns the
 * company. That disagreement is the disease this whole job exists to cure, and the
 * trigger was one CRM dropdown click — the role list offers Owner / Sole Member,
 * Authorized Representative, Manager, Accountant and blank, and only the first
 * matches. Returning a REASON instead of null lets both surfaces refuse together,
 * from the same resolution, rather than each improvising.
 */

/** One row of the account's contact links, as both the screen and the route read it. */
export interface AccountContactLink {
  contact_id: string
  role: string | null
}

export type OwnerVia = 'sole_contact' | 'owner_role' | 'member_role'
export type OwnerRefusalReason = 'no_contacts' | 'ambiguous_roles' | 'several_owners' | 'no_usable_name'

/**
 * Both fields are always present rather than forming a discriminated union: TS
 * declines to narrow the union across the return/ternary boundaries these callers
 * use, and a silently `undefined` reason there would pick the wrong refusal message.
 */
export interface OwnerResolution {
  resolved: boolean
  contactId: string | null
  via: OwnerVia | null
  reason: OwnerRefusalReason | null
  /**
   * WHICH role was ambiguous, when several links share one. The message used to
   * say "listed as an owner" even when the clash was on member-ish roles, which
   * sent staff looking at the wrong column in the CRM.
   */
  ambiguousRole: string | null
}

/**
 * Resolve the owner of record.
 *
 * Rule 1 — A COMPANY WITH ONE LINKED PERSON HAS NO AMBIGUITY TO RESOLVE. That
 * person is the owner whatever the role text says (Antonio, 2026-08-12). This is
 * what makes the role list irrelevant for the ordinary single-owner company, and it
 * is why removing the old first-in-list fallback does not strand anyone: the
 * fallback's only real job was this case, and this states it as a rule instead of
 * as an accident of ordering.
 *
 * Rule 2 — With several linked people, go by role: owner-ish first, then member-ish.
 * Case-insensitive, because CRM role values vary in casing and wording ('owner',
 * 'Owner', 'Sole Member') and a strict equality check silently matched nothing for
 * 20+ accounts once already.
 *
 * Rule 3 — Otherwise REFUSE. Several people, none of them identifiable as the owner,
 * is a genuine question we cannot answer, and guessing puts a real person's home
 * address on a legal document naming someone else as owner. Both the screen and the
 * route must show the refusal rather than improvise a placeholder.
 *
 * Production, 2026-08-12: of 225 active accounts with no member roster, 218 match an
 * owner role, 4 match member-ish, and the only 3 with no match have no contact links
 * at all. Nobody is refused today.
 */
export function resolveOwnerOfRecord(links: AccountContactLink[]): OwnerResolution {
  if (links.length === 0) return { resolved: false, contactId: null, via: null, reason: 'no_contacts', ambiguousRole: null }

  // Rule 1: one person, no ambiguity — role text is irrelevant.
  if (links.length === 1) return { resolved: true, contactId: links[0].contact_id, via: 'sole_contact', reason: null, ambiguousRole: null }

  // SEVERAL owner-ish links is a refusal, not a race. Taking the first would be
  // the same silent guess the address path was fixed to stop — deterministic, yes,
  // but it names one of two real people as SOLE member of a company on a legal
  // instrument. Antonio, 2026-08-12: "Where several owner-role links exist, refuse.
  // Do not pick one silently. Same rule you already applied to the address."
  const owners = links.filter(l => /owner|sole member/i.test(l.role ?? ''))
  if (owners.length === 1) return { resolved: true, contactId: owners[0].contact_id, via: 'owner_role', reason: null, ambiguousRole: null }
  if (owners.length > 1) return { resolved: false, contactId: null, via: null, reason: 'several_owners', ambiguousRole: 'an owner' }

  const members = links.filter(l => /member/i.test(l.role ?? ''))
  if (members.length === 1) return { resolved: true, contactId: members[0].contact_id, via: 'member_role', reason: null, ambiguousRole: null }
  if (members.length > 1) return { resolved: false, contactId: null, via: null, reason: 'several_owners', ambiguousRole: 'a member' }

  return { resolved: false, contactId: null, via: null, reason: 'ambiguous_roles', ambiguousRole: null }
}

/** Convenience for callers that only need the id and treat a refusal as absence. */
export function ownerContactIdOrNull(links: AccountContactLink[]): string | null {
  const r = resolveOwnerOfRecord(links)
  return r.resolved ? r.contactId : null
}

// ─── The NAME on the document ────────────────────────────────────────────────

/** The name columns both surfaces read for the owner. */
export interface OwnerNameSource {
  full_name?: string | null
  first_name?: string | null
  last_name?: string | null
}

/**
 * The owner's name for the document — ONE helper, ONE precedence, both surfaces.
 *
 * Why this exists: the screen built the name from first + last, the route used
 * full_name, and first/last are optional while full_name is what is reliably
 * populated (78 of 473 production contacts are missing one of the two parts). So
 * the preview printed a partial name — or the literal string "N/A" — while the
 * stored agreement printed the real one. Preview and signed document naming
 * different people is the disease this whole job exists to cure; it merely moved
 * from the address to the name.
 *
 * Returns null when no usable name exists. **Callers must REFUSE on null, never
 * substitute a placeholder.** "N/A" as the sole member of a company is not a
 * document defect to be tidied up later — it is a legal instrument naming nobody.
 */
export function resolveOwnerName(contact: OwnerNameSource | null | undefined): string | null {
  if (!contact) return null
  const full = (contact.full_name ?? '').trim()
  if (full) return full
  const joined = [contact.first_name ?? '', contact.last_name ?? ''].map(p => p.trim()).filter(Boolean).join(' ')
  return joined || null
}
