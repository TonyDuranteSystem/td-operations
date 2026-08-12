/**
 * Dev job `61f184ca` — the Operating Agreement create route's own decisions.
 *
 * WHY THIS FILE EXISTS. The address resolver was mutation-proven; everything
 * around it was verified by me reading my own code. A fail-open database read
 * survived that reading and was found only by an adversarial reviewer, in a path
 * that produces legal documents. Antonio's ruling: close the gap before shipping,
 * not as a follow-up — "you read your code, believed it was right, and had put a
 * fail-open defect in it."
 *
 * Each block below is named for the MUTATION it is here to catch. If you change
 * the behaviour deliberately, expect the matching test to fail and rewrite it on
 * purpose; if it fails and you did not mean to change behaviour, you have just
 * been caught.
 *
 * A Single Member LLC has NO member roster BY DESIGN (216 active accounts).
 * "No member records" is CORRECT state in every case below, never a gap.
 */

import { describe, it, expect } from 'vitest'

import {
  maySupplyAddress,
  mustRefuseOnMemberReadFailure,
  resolveSoleMemberAddress,
  pickSoleMemberRow,
  formatOwnerContactAddress,
  shouldStoreSoleMemberAddress,
  decideScreenAddressMode,
} from '@/lib/members/oa-address-decisions'
import type { MemberAddressRow } from '@/lib/members/member-address'

const OWNER = 'c-owner'
const ADMIN = 'c-admin'

const memberRow = (over: Partial<MemberAddressRow> & { is_primary?: boolean | null } = {}) => ({
  member_type: 'individual',
  address_street: '10225 Ulmerton Rd 3D',
  address_city: 'Largo',
  address_state: 'FL',
  address_zip: '33771',
  address_country: 'United States',
  is_primary: false,
  ...over,
})

// ── MUTATION 1: delete the refusal that blocks a posted address when member
//    records exist. ────────────────────────────────────────────────────────────

describe('maySupplyAddress — the server-side gate', () => {
  it('MUTATION 1: REFUSES a posted address when the company HAS member records', () => {
    const v = maySupplyAddress({
      supplied: true, hasMemberRecords: true,
      ownerOfRecordContactId: OWNER, callerContactId: OWNER,
    })
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe('has_member_records')
  })

  it('MUTATION 1: the refusal does NOT depend on the screen — even the owner is refused', () => {
    // The browser could post this field regardless of what was rendered. A member
    // of record must not be overwritable by anyone, owner included.
    const v = maySupplyAddress({
      supplied: true, hasMemberRecords: true,
      ownerOfRecordContactId: OWNER, callerContactId: OWNER,
    })
    expect(v.allowed).toBe(false)
  })

  it('refuses a non-owner on a no-roster account, with the OTHER reason', () => {
    const v = maySupplyAddress({
      supplied: true, hasMemberRecords: false,
      ownerOfRecordContactId: OWNER, callerContactId: ADMIN,
    })
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe('not_owner_of_record')
  })

  it('allows the owner of record on a no-roster account', () => {
    const v = maySupplyAddress({
      supplied: true, hasMemberRecords: false,
      ownerOfRecordContactId: OWNER, callerContactId: OWNER,
    })
    expect(v.allowed).toBe(true)
    expect(v.reason).toBeNull()
  })

  it('fails closed when the owner cannot be established', () => {
    const v = maySupplyAddress({
      supplied: true, hasMemberRecords: false,
      ownerOfRecordContactId: null, callerContactId: OWNER,
    })
    expect(v.allowed).toBe(false)
  })

  it('is a no-op when no address was supplied — never blocks an ordinary request', () => {
    expect(maySupplyAddress({
      supplied: false, hasMemberRecords: true,
      ownerOfRecordContactId: null, callerContactId: ADMIN,
    }).allowed).toBe(true)
  })
})

// ── MUTATION 2: remove the fail-closed check on the member lookup. ────────────

describe('mustRefuseOnMemberReadFailure — the fail-closed check', () => {
  it('MUTATION 2: REFUSES when the member lookup errored', () => {
    // A failed read yields no rows, which is indistinguishable from a Single
    // Member LLC's correct empty roster — and both the stored address AND the
    // "may you supply one" gate hang off that distinction.
    expect(mustRefuseOnMemberReadFailure({ message: 'connection reset' })).toBe(true)
  })

  it('proceeds when the lookup succeeded — an empty roster is CORRECT state', () => {
    expect(mustRefuseOnMemberReadFailure(null)).toBe(false)
    expect(mustRefuseOnMemberReadFailure(undefined)).toBe(false)
  })
})

// ── MUTATION 3: pick the wrong member row for a single-member agreement. ──────

describe('pickSoleMemberRow', () => {
  it('MUTATION 3: takes the FLAGGED primary, not whatever the database returned first', () => {
    const rows = [
      memberRow({ address_street: 'WRONG — unflagged first row', is_primary: false }),
      memberRow({ address_street: 'RIGHT — the flagged primary', is_primary: true }),
    ]
    expect(pickSoleMemberRow(rows)?.address_street).toBe('RIGHT — the flagged primary')
  })

  it('MUTATION 3: is stable when the row order changes — ties are unordered in Postgres', () => {
    const a = memberRow({ address_street: 'A', is_primary: false })
    const b = memberRow({ address_street: 'B', is_primary: true })
    expect(pickSoleMemberRow([a, b])?.address_street).toBe('B')
    expect(pickSoleMemberRow([b, a])?.address_street).toBe('B')
  })

  it('falls back to the first row only when NOTHING is flagged', () => {
    const rows = [memberRow({ address_street: 'first' }), memberRow({ address_street: 'second' })]
    expect(pickSoleMemberRow(rows)?.address_street).toBe('first')
  })

  it('returns null for an empty roster rather than throwing', () => {
    expect(pickSoleMemberRow([])).toBeNull()
  })
})

// ── MUTATION 4: un-blank the field the single-member template reads. ──────────

describe('shouldStoreSoleMemberAddress', () => {
  it('MUTATION 4: does NOT store it for a multi-member agreement', () => {
    // Only the SMLLC template renders it; a multi-member agreement prints the
    // roster. Storing it there filed one member's address in a column labelled
    // as the sole member's, read by nobody.
    expect(shouldStoreSoleMemberAddress(true)).toBe(false)
  })

  it('stores it for a single-member agreement, which is the only reader', () => {
    expect(shouldStoreSoleMemberAddress(false)).toBe(true)
  })
})

// ── MUTATION 5: hardcode the screen to always treat addresses as read-only. ───

describe('decideScreenAddressMode', () => {
  it('MUTATION 5: the owner of a no-roster account CAN edit — not always read-only', () => {
    const m = decideScreenAddressMode({
      memberRowCount: 0, ownerOfRecordContactId: OWNER, viewerContactId: OWNER,
    })
    expect(m.membersFromRecord).toBe(false)
    expect(m.canEditSoleOwnerAddress).toBe(true)
  })

  it('MUTATION 5: a company WITH member records is read-only for everyone', () => {
    const m = decideScreenAddressMode({
      memberRowCount: 3, ownerOfRecordContactId: OWNER, viewerContactId: OWNER,
    })
    expect(m.membersFromRecord).toBe(true)
    expect(m.canEditSoleOwnerAddress).toBe(false)
  })

  it('a non-owner on a no-roster account is read-only', () => {
    const m = decideScreenAddressMode({
      memberRowCount: 0, ownerOfRecordContactId: OWNER, viewerContactId: ADMIN,
    })
    expect(m.canEditSoleOwnerAddress).toBe(false)
  })

  it('agrees with the SERVER gate in every combination — they must never diverge', () => {
    for (const memberRowCount of [0, 2]) {
      for (const viewer of [OWNER, ADMIN, null]) {
        const screen = decideScreenAddressMode({
          memberRowCount, ownerOfRecordContactId: OWNER, viewerContactId: viewer,
        })
        const server = maySupplyAddress({
          supplied: true, hasMemberRecords: memberRowCount > 0,
          ownerOfRecordContactId: OWNER, callerContactId: viewer,
        })
        expect(screen.canEditSoleOwnerAddress).toBe(server.allowed)
      }
    }
  })
})

// ── Which address the agreement actually stores ───────────────────────────────

describe('resolveSoleMemberAddress', () => {
  it('takes the member row when the account has one — the record is authoritative', () => {
    expect(resolveSoleMemberAddress({
      hasMemberRecords: true,
      primaryMemberRow: memberRow({ is_primary: true }),
      suppliedAddress: memberRow({ address_street: 'TYPED — must be ignored' }),
      suppliedAllowed: true,
      ownerRecordAddress: 'CONTACT — must be ignored',
    })).toBe('10225 Ulmerton Rd 3D, Largo, FL, 33771, United States')
  })

  it('uses a supplied address ONLY when the gate allowed it', () => {
    const supplied = memberRow({ address_street: 'Via Roma 1', address_city: 'Milano', address_state: 'MI', address_zip: '20100', address_country: 'Italy' })
    expect(resolveSoleMemberAddress({
      hasMemberRecords: false, primaryMemberRow: null,
      suppliedAddress: supplied, suppliedAllowed: true, ownerRecordAddress: null,
    })).toBe('Via Roma 1, Milano, MI, 20100, Italy')

    // Present in the body but refused by the gate — must NOT reach the document.
    expect(resolveSoleMemberAddress({
      hasMemberRecords: false, primaryMemberRow: null,
      suppliedAddress: supplied, suppliedAllowed: false, ownerRecordAddress: 'ON RECORD',
    })).toBe('ON RECORD')
  })

  it('THE REGENERATE DEFECT: falls back to the owner record when nothing was typed', () => {
    // A client generating a second agreement without retyping previously stored
    // NO address while their record held one.
    expect(resolveSoleMemberAddress({
      hasMemberRecords: false, primaryMemberRow: null,
      suppliedAddress: null, suppliedAllowed: false,
      ownerRecordAddress: 'Praceta Pedro Ivo 5, Amadora, 2700-652, Portugal',
    })).toBe('Praceta Pedro Ivo 5, Amadora, 2700-652, Portugal')
  })

  it('NEGATIVE CELL: substitutes nothing when there is nothing anywhere', () => {
    expect(resolveSoleMemberAddress({
      hasMemberRecords: false, primaryMemberRow: null,
      suppliedAddress: null, suppliedAllowed: true, ownerRecordAddress: null,
    })).toBeNull()
  })
})

describe('formatOwnerContactAddress', () => {
  it('includes the postal code — dropping it is how screen and document diverged', () => {
    expect(formatOwnerContactAddress({
      address_line1: '30 N Gould St', address_city: 'Sheridan',
      address_state: 'WY', address_zip: '82801', address_country: 'USA',
    })).toBe('30 N Gould St, Sheridan, WY, 82801, USA')
  })

  it('returns null for a contact with no address, never an empty string', () => {
    expect(formatOwnerContactAddress(null)).toBeNull()
    expect(formatOwnerContactAddress({
      address_line1: null, address_city: null, address_state: null,
      address_zip: null, address_country: null,
    })).toBeNull()
  })
})
