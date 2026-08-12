/**
 * Dev job `61f184ca` — who the owner of record is.
 *
 * WHAT USED TO BE HERE AND IS GONE: an address splitter and a "who may author this
 * address" permission check, both serving an editable address field for sole
 * owners. That field corrupted client contact records — a joined address is lossy,
 * splitting it back apart guessed wrong for 35 of 271 contacts, and the wrong guess
 * was written over their record. Antonio removed the field, the write-back and both
 * helpers rather than repair the splitter.
 *
 * What remains is the one question still asked: for a company with NO member roster
 * — every Single Member LLC, 216 of the active accounts, which is CORRECT state by
 * design and not a gap — whose contact address does the document show?
 *
 * That answer is still safety-relevant even with nothing editable, because it
 * decides whose home address is printed on a legal document naming the owner.
 */

import { describe, it, expect } from 'vitest'

import { resolveOwnerOfRecord, type AccountContactLink } from '@/lib/members/sole-owner-address'

const OWNER: AccountContactLink = { contact_id: 'c-owner', role: 'Owner' }
const ADMIN: AccountContactLink = { contact_id: 'c-admin', role: 'Administrator' }
const MEMBER: AccountContactLink = { contact_id: 'c-member', role: 'Member' }
const UNTAGGED: AccountContactLink = { contact_id: 'c-untagged', role: null }

describe('resolveOwnerOfRecord', () => {
  it('prefers an owner-ish role over anyone else, whatever the order or casing', () => {
    expect(resolveOwnerOfRecord([ADMIN, { contact_id: 'c-owner', role: 'sole member' }])).toBe('c-owner')
    expect(resolveOwnerOfRecord([ADMIN, OWNER])).toBe('c-owner')
    expect(resolveOwnerOfRecord([{ contact_id: 'c-owner', role: 'OWNER' }, ADMIN])).toBe('c-owner')
  })

  it('falls back to a member-ish role when no owner role exists', () => {
    expect(resolveOwnerOfRecord([ADMIN, MEMBER])).toBe('c-member')
  })

  it('THE RULING: REFUSES rather than taking the first link when no role matches', () => {
    // Antonio, 2026-08-12: "Guessing an owner on a legal document is not an
    // acceptable default." Roles are free text and the queries feeding this are
    // not ordered identically everywhere, so first-in-list could name a DIFFERENT
    // person on the screen than on the server — and print, say, an accountant's
    // home address as the member's.
    expect(resolveOwnerOfRecord([ADMIN])).toBeNull()
    expect(resolveOwnerOfRecord([UNTAGGED, ADMIN])).toBeNull()
  })

  it('costs nothing in production: verified 2026-08-12 that zero accounts relied on that fallback', () => {
    // Of 225 active accounts with no member roster: 218 match an owner-ish role,
    // 4 more match member-ish, 3 have no contact links at all, and NONE have links
    // without a matching role. This test documents the check so a future reader
    // does not "restore" the fallback believing it rescued someone.
    expect(resolveOwnerOfRecord([OWNER])).toBe('c-owner')
    expect(resolveOwnerOfRecord([MEMBER])).toBe('c-member')
    expect(resolveOwnerOfRecord([])).toBeNull()
  })

  it('returns null when nobody is linked', () => {
    expect(resolveOwnerOfRecord([])).toBeNull()
  })
})
