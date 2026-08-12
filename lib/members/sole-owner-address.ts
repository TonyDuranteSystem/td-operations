/**
 * Who the owner of record is, for a company with no member roster.
 *
 * ── WHAT THIS FILE NO LONGER DOES ──
 *
 * It used to also hold the machinery for letting a sole owner TYPE their address
 * on the Generate Documents screen: a splitter that reversed a stored one-line
 * address back into five form fields, and a permission check for who was allowed
 * to author it. Both are DELETED (Antonio, 2026-08-12) and must not come back.
 *
 * The splitter was the defect. A joined address is LOSSY: 35 of the 271 contacts
 * with an address have fewer than five parts — no state, or no country, which is
 * every Italian, Portuguese and Hungarian address without a province. Splitting
 * those back apart cannot tell WHICH field is missing, so the whole line landed in
 * the street box and the remaining blanks were posted back and written literally
 * over the client's contact record, erasing city, state, postal code and country.
 * Silently, because the re-joined line still read correctly in the document.
 *
 * The ruling that replaced it: a Single Member LLC's address is shown READ-ONLY
 * from the owner's contact record, exactly as a multi-member company's addresses
 * are shown from its member rows. If it is wrong the client contacts support. That
 * removed the corruption, a collision with a second column other code reads as a
 * country, and a write from a document screen into a person's contact record — all
 * at once, instead of patching three things. It is the original "the record wins
 * and nothing is typeable" ruling applied consistently rather than carved out.
 *
 * NOTHING on the Operating Agreement screen is editable. If you are about to add a
 * field there, read that paragraph again first.
 */

/** One row of the account's contact links, as both the screen and the route read it. */
export interface AccountContactLink {
  contact_id: string
  role: string | null
}

/**
 * The owner of record for an account, from its contact links.
 *
 * REFUSES rather than guessing. There is deliberately no "otherwise take the first
 * link" fallback: roles are free text, so first-in-list is arbitrary, and the
 * queries feeding this are not ordered identically everywhere — so the fallback
 * could name a DIFFERENT person on the screen than on the server, and print an
 * accountant's home address as the member's on a legal document. Antonio, 2026-08-12:
 * "Guessing an owner on a legal document is not an acceptable default."
 *
 * Checked against production before removing that fallback: of 225 active accounts
 * with no member roster, 218 have an owner-ish role and 4 more match member-ish;
 * ZERO have contact links but no matching role. The fallback was rescuing nobody.
 *
 * Role values vary in casing and wording across the CRM ('owner', 'Owner', 'Sole
 * Member'), hence the case-insensitive test — a strict equality check silently
 * matched nothing for 20+ accounts once already.
 */
export function resolveOwnerOfRecord(links: AccountContactLink[]): string | null {
  const owner =
    links.find(l => /owner|sole member/i.test(l.role ?? '')) ??
    links.find(l => /member/i.test(l.role ?? '')) ??
    null
  return owner?.contact_id ?? null
}
