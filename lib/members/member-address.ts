/**
 * THE member address resolver — one function, used by BOTH the screen a client
 * reviews and the route that writes the legal document.
 *
 * ⛔ WHY THIS EXISTS AT ALL (dev job `61f184ca`, Michele Cotti / AI Venture Labs,
 * 2026-08-12).
 *
 * The portal had TWO independent answers to "what is this member's address":
 * `getPortalMembers` built one for the screen, and the OA create route composed
 * another for the stored agreement. They disagreed, so a client reviewed one
 * document and signed a different one. For a COMPANY member the screen resolved
 * `representative_address_* ?? address_*` — the human who signs on the entity's
 * behalf outranked the entity itself — so Whalecot Consulting LLC (a Florida
 * company) was shown to its own owner carrying his personal Portuguese home
 * address. He reported it; he was right.
 *
 * Antonio's ruling (2026-08-12): "A legal document must never be able to
 * disagree with the system of record." The record wins, the addresses are
 * read-only on that screen, and the free-typing path that let the two diverge was
 * deleted rather than repaired. This module is the one formatter both the screens
 * and the create route call, so they agree by construction rather than by three
 * call sites happening to stay in step.
 *
 * ── THE RULES, and why each one is the way it is ──
 *
 * COMPANY member → the entity's OWN address. Never the representative's, never
 * a contact record. The representative is a person authorised to sign for the
 * entity; the member of record is the entity. Article 2.1 of both templates
 * prints "The Members of the Company, THEIR ADDRESSES, and their respective
 * ownership interests" — that is the entity's address, and there is no notice
 * block or signature-block address anywhere in the templates that wants the
 * person's. Every other document path in the repo already agrees: the staff OA
 * door, the Intercompany Agreement assembler, and the OA create route all
 * compose from `address_*` only. This read path was the lone outlier.
 *
 * NO FALLBACK when a company member has no address of its own. Falling through
 * to the representative is precisely the defect above; falling through to the
 * linked contact is the same defect wearing a different hat, because a company
 * member's `contact_id` IS the representative's contact. An absent address must
 * stay visibly absent — the template already prints "As on file with the
 * Company", which is an honest marker, not a substituted value. (Today this is
 * theoretical: all 9 production company-member rows carry their own address.)
 *
 * INDIVIDUAL member → this resolver returns the member row. `getPortalMembers`
 * still applies its PRE-EXISTING contact-first precedence for individuals before
 * calling it; that precedence is deliberately unchanged. Whether the member row
 * should win there is REPORT-ONLY on dev job `271bbe46`.
 *
 * WHOLE address, not field-by-field. Any fallback added here later must swap the
 * entire address at once. Mixing a street from one source with a city from
 * another composes an address that exists nowhere — into a legal document.
 *
 * THE POSTAL CODE IS PART OF THE ADDRESS. It is listed explicitly below because
 * omitting it is exactly how this went wrong once already: the screen's query
 * never selected the zip columns, so every address a client reviewed was
 * missing its postal code while the stored agreement carried one. Anything
 * selecting member address columns must select the zip too.
 */

/** The `members` columns this resolver reads. Zip included — see the note above. */
export interface MemberAddressRow {
  member_type: string | null
  address_street: string | null
  address_city: string | null
  address_state: string | null
  address_zip: string | null
  address_country: string | null
}

/** A resolved address, still in parts so callers can render or join as they need. */
export interface MemberAddressParts {
  line1: string | null
  city: string | null
  state: string | null
  zip: string | null
  country: string | null
}

export const EMPTY_MEMBER_ADDRESS: MemberAddressParts = {
  line1: null,
  city: null,
  state: null,
  zip: null,
  country: null,
}

/** Blank-safe: treats "", "   " and null identically, so a whitespace-only cell never reads as present. */
function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Resolve the address of record for one member row.
 *
 * Identical for company and individual members today — the entity's / person's
 * own address, with no fallback of any kind. The branch is kept explicit rather
 * than collapsed because the two types differ in WHY they have no fallback, and
 * a future change is overwhelmingly likely to want to change exactly one of
 * them. Collapsing them would make that a silent change to both.
 */
export function resolveMemberAddress(member: MemberAddressRow | null | undefined): MemberAddressParts {
  if (!member) return EMPTY_MEMBER_ADDRESS

  return {
    line1: clean(member.address_street),
    city: clean(member.address_city),
    state: clean(member.address_state),
    zip: clean(member.address_zip),
    country: clean(member.address_country),
  }
}

/** True when the resolver found nothing at all — the caller must say so, not substitute. */
export function isMemberAddressEmpty(parts: MemberAddressParts): boolean {
  return !parts.line1 && !parts.city && !parts.state && !parts.zip && !parts.country
}

/**
 * Join a resolved address into the single line that goes on screen and into the
 * document. Returns null (never "" and never a string of stray commas) when
 * there is nothing to show, so callers can branch on absence.
 *
 * Order is street, city, state, ZIP, country — matching what the staff OA door
 * and the Intercompany assembler already produce, so the same member reads the
 * same way whichever door generated the paperwork.
 */
export function formatMemberAddress(parts: MemberAddressParts): string | null {
  const joined = [parts.line1, parts.city, parts.state, parts.zip, parts.country]
    .filter((part): part is string => !!part)
    .join(', ')
  return joined.length > 0 ? joined : null
}

/** Convenience for the common "row in, one line out" call. */
export function formatMemberAddressRow(member: MemberAddressRow | null | undefined): string | null {
  return formatMemberAddress(resolveMemberAddress(member))
}
