/**
 * The decisions the Operating Agreement create route makes about member addresses
 * — pulled out of the route so they can actually be tested.
 *
 * ── WHY THEY LIVE HERE ──
 *
 * Dev job `61f184ca`. The first cut of that fix was mutation-proven on the address
 * RESOLVER, and everything around it was verified by reading the code. A fail-open
 * database read survived that reading and was caught only by an adversarial review
 * — in a path that produces legal documents.
 *
 * ── AND WHY THIS FILE IS NOW SMALLER THAN IT WAS ──
 *
 * The extraction itself then produced a data-corruption blocker, in the one case
 * that had been carved out of "nothing is typeable": a sole owner could type their
 * address, which meant prefilling five form fields by SPLITTING a stored one-line
 * address back apart. That join is lossy, the split guessed wrong for 35 of 271
 * contacts, and the wrong guess was written back over their record.
 *
 * Antonio's ruling: remove the editable field and the write-back entirely, rather
 * than fix the splitter. So `maySupplyAddress` and `decideScreenAddressMode` are
 * GONE, and what remains never accepts a client-supplied address at all. NOTHING on
 * that screen is editable — for any company, of any shape.
 *
 * A Single Member LLC has NO member roster BY DESIGN (216 of the active accounts).
 * "No member records" is CORRECT state throughout this file, never a gap: for those
 * companies the address of record simply lives on the owner's contact instead.
 */

import { formatMemberAddress, formatMemberAddressRow, type MemberAddressRow } from '@/lib/members/member-address'

/**
 * DECISION 1 — reject any address supplied by the caller.
 *
 * There is no legitimate sender: the screen renders every address read-only, so a
 * request carrying one is either a stale client or a crafted post. Kept as an
 * explicit, tested refusal rather than silently ignoring the field, because
 * "silently discarded" is exactly what the deleted editable field did — it looked
 * like it worked and did nothing, and a client correcting a wrong address had no
 * way to succeed and no way to know they had failed.
 */
export function mustRefuseSuppliedAddress(body: Record<string, unknown> | null | undefined): boolean {
  if (!body) return false
  // Both the old array form and the short-lived single-address form.
  return body.member_addresses !== undefined || body.legacy_member_address !== undefined
}

/**
 * DECISION 2 — what happens when the member lookup FAILS.
 *
 * Split out because the failure is INVISIBLE at the call site: a failed read yields
 * no rows, which is indistinguishable from a Single Member LLC's correct empty
 * roster — and the address that goes into the agreement hangs off telling those
 * apart. So "couldn't read" silently became "has none", and the document went wrong
 * while looking perfectly consistent.
 *
 * Returns true when the request must be REFUSED rather than proceeding.
 */
export function mustRefuseOnMemberReadFailure(readError: { message: string } | null | undefined): boolean {
  return !!readError
}

/**
 * DECISION 3 — which address the agreement stores for a single member.
 *
 * Two sources, no typing, no guessing:
 *   1. The member row, when the company has one.
 *   2. Otherwise the OWNER OF RECORD's contact address — for a Single Member LLC
 *      that record IS the address of record, and it is what the screen displays
 *      read-only, so the client reviews exactly what gets stored.
 *   3. Otherwise null, and the template prints "As on file with the Company".
 *      Never a substituted value, never the representative's personal address.
 */
export function resolveSoleMemberAddress(input: {
  hasMemberRecords: boolean
  primaryMemberRow: MemberAddressRow | null
  ownerRecordAddress: string | null
}): string | null {
  if (input.hasMemberRecords) return formatMemberAddressRow(input.primaryMemberRow)
  return input.ownerRecordAddress ?? null
}

/**
 * Which member row a SINGLE-member agreement takes its address from.
 *
 * `[0]` after an `is_primary DESC` sort is NOT safe on its own: the column is
 * nullable and Postgres sorts DESC as NULLS FIRST, so an unflagged row can come
 * back ahead of the flagged one, and ties are unordered besides. Two consecutive
 * generations could put a different member's address in a legal document. Prefer
 * the flagged primary explicitly; fall back to the first row only when nothing is
 * flagged at all.
 */
export function pickSoleMemberRow<T extends { is_primary?: boolean | null }>(rows: T[]): T | null {
  if (rows.length === 0) return null
  return rows.find(r => r.is_primary === true) ?? rows[0]
}

/**
 * Format an owner's contact record into the one-line address the document stores
 * and the screen displays. Shared so the two cannot render it differently —
 * including the postal code, which an earlier hand-rolled join silently dropped.
 */
export function formatOwnerContactAddress(contact: {
  address_line1: string | null
  address_city: string | null
  address_state: string | null
  address_zip: string | null
  address_country: string | null
} | null | undefined): string | null {
  if (!contact) return null
  return formatMemberAddress({
    line1: contact.address_line1,
    city: contact.address_city,
    state: contact.address_state,
    zip: contact.address_zip,
    country: contact.address_country,
  })
}

/**
 * Whether the single-member address column should be written at all.
 *
 * Only the SMLLC template renders it (Article 2.1 "Sole Member"); the multi-member
 * templates print the roster instead. It previously stored the browser's first
 * typed value even on a multi-member agreement — one member's address filed in a
 * column labelled as the sole member's, read by nobody.
 */
export function shouldStoreSoleMemberAddress(isMultiMember: boolean): boolean {
  return !isMultiMember
}
