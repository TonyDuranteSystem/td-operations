/**
 * Unit tests for MMLLC primary member selector logic (Area C + D)
 *
 * Tests the pure logic of:
 * 1. primaryMemberIndex shift when a member is removed
 * 2. primary_member_index stored in submittedData only for MMLLC
 * 3. isPrimary assignment in formation-setup member loop
 */

import { describe, it, expect } from 'vitest'

// ─── Primary member index shift logic ──────────────────────────
// Mirrors the onClick in renderMembers remove button

function shiftPrimaryOnRemove(currentPrimary: number, removedIndex: number): number {
  // removedIndex is 0-based among members array; primaryMemberIndex uses 0=owner, 1+=member
  const memberSlot = removedIndex + 1
  if (currentPrimary === memberSlot) return 0         // removed the primary → revert to owner
  if (currentPrimary > memberSlot) return currentPrimary - 1 // shift down
  return currentPrimary                                // unaffected
}

describe('shiftPrimaryOnRemove', () => {
  it('reverts to owner when primary member is removed', () => {
    expect(shiftPrimaryOnRemove(1, 0)).toBe(0)  // member #1 was primary, removed member[0]
    expect(shiftPrimaryOnRemove(2, 1)).toBe(0)  // member #2 was primary, removed member[1]
  })

  it('shifts index down when a member before primary is removed', () => {
    expect(shiftPrimaryOnRemove(2, 0)).toBe(1)  // primary was member #2, remove member[0] → now #1
    expect(shiftPrimaryOnRemove(3, 1)).toBe(2)  // primary was member #3, remove member[1] → now #2
  })

  it('does not change index when a member after primary is removed', () => {
    expect(shiftPrimaryOnRemove(1, 1)).toBe(1)  // primary is member #1, remove member[1] → still #1
    expect(shiftPrimaryOnRemove(1, 2)).toBe(1)
    expect(shiftPrimaryOnRemove(0, 0)).toBe(0)  // owner is primary, any member removed → still owner
  })

  it('does not change owner primary when any member is removed', () => {
    expect(shiftPrimaryOnRemove(0, 0)).toBe(0)
    expect(shiftPrimaryOnRemove(0, 3)).toBe(0)
  })
})

// ─── submittedData: primary_member_index only for MMLLC ────────

function buildSubmittedData(
  formData: Record<string, unknown>,
  members: Record<string, string>[],
  primaryMemberIndex: number,
  entityType: string,
): Record<string, unknown> {
  const submittedData: Record<string, unknown> = { ...formData }
  if (members.length > 0) {
    submittedData.additional_members = members
    if (entityType === 'MMLLC') submittedData.primary_member_index = primaryMemberIndex
  }
  return submittedData
}

describe('buildSubmittedData primary_member_index', () => {
  const member = { member_first_name: 'Jane', member_last_name: 'Doe', member_email: 'jane@test.com', member_ownership_pct: '50' }

  it('includes primary_member_index for MMLLC when members present', () => {
    const d = buildSubmittedData({}, [member], 1, 'MMLLC')
    expect(d.primary_member_index).toBe(1)
    expect(d.additional_members).toHaveLength(1)
  })

  it('uses 0 (owner) as default primary', () => {
    const d = buildSubmittedData({}, [member], 0, 'MMLLC')
    expect(d.primary_member_index).toBe(0)
  })

  it('does NOT include primary_member_index for SMLLC', () => {
    const d = buildSubmittedData({}, [member], 0, 'SMLLC')
    expect(d.primary_member_index).toBeUndefined()
  })

  it('does NOT include primary_member_index when no members', () => {
    const d = buildSubmittedData({}, [], 0, 'MMLLC')
    expect(d.primary_member_index).toBeUndefined()
    expect(d.additional_members).toBeUndefined()
  })
})

// ─── isPrimary assignment in formation-setup member loop ───────

function computeMemberIsPrimary(primaryMemberIndex: number, memberLoopIndex: number): boolean {
  return primaryMemberIndex === memberLoopIndex + 1
}

describe('computeMemberIsPrimary', () => {
  it('marks the correct member as primary', () => {
    expect(computeMemberIsPrimary(1, 0)).toBe(true)   // member[0] is primary
    expect(computeMemberIsPrimary(2, 1)).toBe(true)   // member[1] is primary
  })

  it('does not mark other members as primary', () => {
    expect(computeMemberIsPrimary(1, 1)).toBe(false)
    expect(computeMemberIsPrimary(2, 0)).toBe(false)
  })

  it('marks no member as primary when owner is primary (index=0)', () => {
    expect(computeMemberIsPrimary(0, 0)).toBe(false)
    expect(computeMemberIsPrimary(0, 1)).toBe(false)
    expect(computeMemberIsPrimary(0, 99)).toBe(false)
  })
})
