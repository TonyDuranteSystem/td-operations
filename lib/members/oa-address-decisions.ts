/**
 * The three decisions the Operating Agreement create route makes about member
 * addresses — pulled out of the route so they can actually be tested.
 *
 * ── WHY THEY LIVE HERE AND NOT IN THE ROUTE ──
 *
 * Dev job `61f184ca`. The first cut of that fix was mutation-proven on the address
 * RESOLVER, and everything around it was verified by reading the code. A fail-open
 * database read survived that reading and was caught only by an adversarial review
 * — in a path that produces legal documents. Antonio's ruling (2026-08-12): the
 * route's own decisions get the same treatment as the resolver, because "you read
 * your code, believed it was right, and had put a fail-open defect in it".
 *
 * The route itself is a long Next handler doing auth, state validation, deletes,
 * inserts and notifications; a test that mocked all of that would assert the mock.
 * These three functions are the parts where being wrong changes what a client
 * signs, so they are pure, and the route is left holding only I/O and sequencing.
 *
 * A Single Member LLC has NO member roster BY DESIGN — 216 of the active accounts.
 * "No member records" is CORRECT state throughout this file, never a gap.
 */

import { formatMemberAddress, formatMemberAddressRow, type MemberAddressRow } from '@/lib/members/member-address'
import { canAuthorSoleOwnerAddress } from '@/lib/members/sole-owner-address'

/** Outcome of the "may this request supply an address at all" gate. */
export type AddressRefusalReason = 'has_member_records' | 'not_owner_of_record'

/**
 * `reason` is present-but-null when allowed, rather than absent, so callers can
 * branch on it without relying on TypeScript narrowing a union across a
 * `return`/ternary boundary — which it declines to do here, and a silent
 * `undefined` in that position would pick the wrong refusal message.
 */
export interface AddressSubmissionVerdict {
  allowed: boolean
  reason: AddressRefusalReason | null
}

/**
 * DECISION 1 — may this request supply an address?
 *
 * Only a no-roster account, and only from the owner of record. Enforced on the
 * SERVER, deliberately not left to whether the screen chose to render a read-only
 * field: a client posting the field directly must not be able to overwrite a
 * member of record, or write an address into another person's contact.
 *
 * Called with `supplied: false` this is a no-op — a request that sends no address
 * is always fine, whatever the account looks like.
 */
export function maySupplyAddress(input: {
  supplied: boolean
  hasMemberRecords: boolean
  ownerOfRecordContactId: string | null
  callerContactId: string | null
}): AddressSubmissionVerdict {
  if (!input.supplied) return { allowed: true, reason: null }
  if (input.hasMemberRecords) return { allowed: false, reason: 'has_member_records' }
  if (!canAuthorSoleOwnerAddress({
    hasMemberRecords: input.hasMemberRecords,
    ownerOfRecordContactId: input.ownerOfRecordContactId,
    viewerContactId: input.callerContactId,
  })) {
    return { allowed: false, reason: 'not_owner_of_record' }
  }
  return { allowed: true, reason: null }
}

/**
 * DECISION 2 — what happens when the member lookup FAILS.
 *
 * Split out because the failure is INVISIBLE at the call site: a failed read
 * yields no rows, which is indistinguishable from a Single Member LLC's correct
 * empty roster. Two things hang off that distinction — the address stored in the
 * agreement, and whether a browser may supply one — so "couldn't read" silently
 * became "has none", and both the document and the gate went wrong together while
 * looking perfectly consistent.
 *
 * Returns true when the request must be REFUSED rather than proceeding.
 */
export function mustRefuseOnMemberReadFailure(readError: { message: string } | null | undefined): boolean {
  return !!readError
}

/**
 * DECISION 3 — which address the agreement stores for a single member.
 *
 * Precedence, and each step exists for a reason a previous version got wrong:
 *   1. The member row, when the account has one. The record is authoritative.
 *   2. Otherwise the address supplied on this request — but ONLY when decision 1
 *      allowed it (the caller passes `suppliedAllowed`), never merely because it
 *      was present in the body.
 *   3. Otherwise the owner's own contact record. Without this, a client who
 *      generated once and regenerated later WITHOUT retyping stored an agreement
 *      with no address at all, while their record held one — the same
 *      record-vs-document split this whole job exists to close, on the one path
 *      left editable.
 *   4. Otherwise null, and the template prints "As on file with the Company".
 *      Never a substituted value, never the representative's personal address.
 */
export function resolveSoleMemberAddress(input: {
  hasMemberRecords: boolean
  primaryMemberRow: MemberAddressRow | null
  suppliedAddress: MemberAddressRow | null
  suppliedAllowed: boolean
  ownerRecordAddress: string | null
}): string | null {
  if (input.hasMemberRecords) return formatMemberAddressRow(input.primaryMemberRow)
  if (input.suppliedAllowed && input.suppliedAddress) {
    const formatted = formatMemberAddressRow(input.suppliedAddress)
    if (formatted) return formatted
  }
  return input.ownerRecordAddress ?? null
}

/**
 * Which member row a SINGLE-member agreement takes its address from.
 *
 * `[0]` after an `is_primary DESC` sort is NOT safe on its own: ties are unordered
 * in Postgres, so an account whose rows are all unflagged (or multiply flagged)
 * could yield a different member on two consecutive generations — a different
 * address in a legal document each time. Prefer the flagged primary explicitly,
 * and fall back to the first row only when nothing is flagged.
 */
export function pickSoleMemberRow<T extends { is_primary?: boolean | null }>(rows: T[]): T | null {
  if (rows.length === 0) return null
  return rows.find(r => r.is_primary === true) ?? rows[0]
}

/**
 * Format an owner's contact record into the one-line address used as the last
 * fallback above. Kept here so the route never hand-rolls a second joiner — the
 * screen and the document must render an address the same way, including the
 * postal code, which an earlier hand-rolled join silently dropped.
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
 * Only the SMLLC template renders it (Article 2.1 "Sole Member"); the
 * multi-member templates print the roster instead. It previously stored the
 * browser's first typed value even on a multi-member agreement — one member's
 * address filed in a column labelled as the sole member's, read by nobody.
 */
export function shouldStoreSoleMemberAddress(isMultiMember: boolean): boolean {
  return !isMultiMember
}

/**
 * What the Generate Documents SCREEN renders — read-only addresses, or one
 * editable address for the owner.
 *
 * Here rather than inline in the page for the same reason as the rest: inline, a
 * one-character change ("always read-only", "always editable") is invisible to
 * every test in the repo, and this decides whether a client can author a value
 * that lands in a legal document and in someone's contact record.
 *
 * Returns the two flags the screen consumes, so the page has no logic of its own
 * to drift from the server's copy of the same decision.
 */
export function decideScreenAddressMode(input: {
  memberRowCount: number
  ownerOfRecordContactId: string | null
  viewerContactId: string | null
}): { membersFromRecord: boolean; canEditSoleOwnerAddress: boolean } {
  const membersFromRecord = input.memberRowCount > 0
  return {
    membersFromRecord,
    canEditSoleOwnerAddress: canAuthorSoleOwnerAddress({
      hasMemberRecords: membersFromRecord,
      ownerOfRecordContactId: input.ownerOfRecordContactId,
      viewerContactId: input.viewerContactId,
    }),
  }
}
