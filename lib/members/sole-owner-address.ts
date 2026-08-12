/**
 * The sole-owner address path — who owns it, who may author it, and how a stored
 * address is put back into an editable form.
 *
 * ── WHY THIS FILE EXISTS ──
 *
 * A Single Member LLC has NO member roster BY DESIGN — 216 of the active accounts
 * are exactly this. "No member records" is CORRECT STATE, not a legacy gap, not a
 * hole, and not a backfill candidate. Do not describe it as one. It means this is
 * the NORMAL path for most clients, so the decisions below are load-bearing rather
 * than edge-case handling.
 *
 * The address for such an account lives on the owner's own contact record, and the
 * client can set it while generating their Operating Agreement. That makes three
 * decisions safety-relevant, and each was got wrong in the first cut of dev job
 * `61f184ca`:
 *
 *   1. WHO the address belongs to. It follows the OWNER OF RECORD, never whoever
 *      happens to be signed in (Antonio, 2026-08-12: "Who logged in is an accident;
 *      the agreement names an owner"). The first cut wrote it to the caller, so on
 *      an account with a second linked person the document could name one person
 *      while the address — and the patched contact record — belonged to another.
 *   2. WHETHER the viewer may author it at all. Only the owner. Anyone else sees
 *      the record read-only; nobody types an address into someone else's record.
 *   3. HOW an address already on record gets back into the form. The record stores
 *      the parts separately and the screen renders one joined line, so without a
 *      split the form opened BLANK for a client who already had an address — and a
 *      client who did not retype stored an agreement with no address while their
 *      record held one. That is the exact record-vs-document split this whole job
 *      exists to close, reproduced on the one path left editable.
 *
 * All three live here, pure and unit-tested, because BOTH the screen and the create
 * route have to reach the same answer. When they disagreed, the screen offered an
 * editable field the server then refused — or worse, accepted for the wrong person.
 */

/** One row of the account's contact links, as both callers read it. */
export interface AccountContactLink {
  contact_id: string
  role: string | null
}

/** The five fields the sole-owner address form edits. */
export interface SoleOwnerAddressFields {
  street: string
  city: string
  state: string
  zip: string
  country: string
}

const BLANK: SoleOwnerAddressFields = { street: '', city: '', state: '', zip: '', country: '' }

/**
 * Split a stored one-line address back into its five fields.
 *
 * Splits from the RIGHT: country, ZIP, state and city are single-token fields,
 * while the street is the only part that legitimately contains commas
 * ("10225 Ulmerton Rd, Suite 3D-205"). Anything left over is the street.
 *
 * Fewer than five parts means we CANNOT say which fields are missing, so the whole
 * string stays in the street box and the rest stay blank. Guessing would shift a
 * city into a state field and the client would sign it.
 */
export function splitStoredAddress(line: string | null | undefined): SoleOwnerAddressFields {
  if (typeof line !== 'string') return { ...BLANK }
  const trimmed = line.trim()
  if (!trimmed) return { ...BLANK }

  const parts = trimmed.split(',').map(p => p.trim()).filter(Boolean)
  if (parts.length < 5) return { ...BLANK, street: trimmed }

  const country = parts.pop() as string
  const zip = parts.pop() as string
  const state = parts.pop() as string
  const city = parts.pop() as string
  return { street: parts.join(', '), city, state, zip, country }
}

/**
 * The owner of record for an account, from its contact links.
 *
 * Preference order — owner-ish role, then member-ish, then the first link — is
 * matched EXACTLY by the screen and by the create route. The route re-derives it
 * server-side rather than trusting the browser, because this id decides whose
 * contact record gets written. Role values vary in casing and wording across the
 * CRM ('owner', 'Owner', 'Sole Member'), hence the case-insensitive test rather
 * than an equality check — a strict match silently returned nobody for 20+
 * accounts once already.
 */
export function resolveOwnerOfRecord(links: AccountContactLink[]): string | null {
  const chosen =
    links.find(l => /owner|sole member/i.test(l.role ?? '')) ??
    links.find(l => /member/i.test(l.role ?? '')) ??
    links[0] ??
    null
  return chosen?.contact_id ?? null
}

/**
 * May this viewer author the sole-owner address?
 *
 * Only when the account has no member roster AND the viewer IS the owner of
 * record. Fails closed when the owner cannot be established — an unknown owner
 * must not become "anyone will do".
 */
export function canAuthorSoleOwnerAddress(input: {
  hasMemberRecords: boolean
  ownerOfRecordContactId: string | null
  viewerContactId: string | null
}): boolean {
  if (input.hasMemberRecords) return false
  if (!input.ownerOfRecordContactId || !input.viewerContactId) return false
  return input.ownerOfRecordContactId === input.viewerContactId
}
