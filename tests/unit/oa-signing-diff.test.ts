import { describe, it, expect } from 'vitest'
import { diffSigningState, type DiffMemberRow, type PinnedMember, type PinnedSignerRow } from '@/lib/oa/signing-diff'

// Two individual owners, 60/40.
const aliceRow = (over: Partial<DiffMemberRow> = {}): DiffMemberRow => ({
  member_type: 'individual', full_name: 'Alice Rossi', company_name: null,
  email: 'alice@example.com', contact_id: 'c-alice', ownership_pct: 60, ...over,
})
const bobRow = (over: Partial<DiffMemberRow> = {}): DiffMemberRow => ({
  member_type: 'individual', full_name: 'Bob Bianchi', company_name: null,
  email: 'bob@example.com', contact_id: 'c-bob', ownership_pct: 40, ...over,
})

const pinnedMembers: PinnedMember[] = [
  { name: 'Alice Rossi', email: 'alice@example.com', ownership_pct: 60 },
  { name: 'Bob Bianchi', email: 'bob@example.com', ownership_pct: 40 },
]
const pinnedSigners: PinnedSignerRow[] = [
  { member_name: 'Alice Rossi', member_email: 'alice@example.com', contact_id: 'c-alice' },
  { member_name: 'Bob Bianchi', member_email: 'bob@example.com', contact_id: 'c-bob' },
]

const baseMMLLC = {
  agreementEntityType: 'Multi Member LLC',
  pinnedMembers,
  pinnedSignerRows: pinnedSigners,
}

describe('diffSigningState — no-op edits are NOT material', () => {
  it('identical roster (different order) is not material', () => {
    const r = diffSigningState({ ...baseMMLLC, liveMemberRows: [bobRow(), aliceRow()] })
    expect(r.material).toBe(false)
  })

  it('phone-only edit is not material (phone is not compared)', () => {
    const r = diffSigningState({ ...baseMMLLC, liveMemberRows: [aliceRow({ phone: '+39 111' } as never), bobRow()] })
    expect(r.material).toBe(false)
  })

  it('member-info re-submit with fresh ids and flipped is_primary is not material', () => {
    const r = diffSigningState({
      ...baseMMLLC,
      liveMemberRows: [
        bobRow({ is_primary: true } as never),
        aliceRow({ is_primary: false } as never),
      ],
    })
    expect(r.material).toBe(false)
  })

  it('null vs 0 ownership on a non-owning member is not material', () => {
    const pinned = [{ name: 'X', email: 'x@e.com', ownership_pct: 0 }, ...pinnedMembers]
    const live = [
      { member_type: 'individual', full_name: 'X', company_name: null, email: 'x@e.com', contact_id: null, ownership_pct: null },
      aliceRow(), bobRow(),
    ] as DiffMemberRow[]
    const r = diffSigningState({
      agreementEntityType: 'MMLLC',
      pinnedMembers: pinned,
      pinnedSignerRows: [{ member_name: 'X', member_email: 'x@e.com', contact_id: null }, ...pinnedSigners],
      liveMemberRows: live,
    })
    expect(r.material).toBe(false)
  })
})

describe('diffSigningState — real changes ARE material', () => {
  it('removed member is material', () => {
    const r = diffSigningState({ ...baseMMLLC, liveMemberRows: [aliceRow({ ownership_pct: 100 })] })
    expect(r.material).toBe(true)
  })

  it('replaced signer (email/contact changed) is material', () => {
    const r = diffSigningState({
      ...baseMMLLC,
      liveMemberRows: [aliceRow(), bobRow({ email: 'carol@example.com', contact_id: 'c-carol', full_name: 'Carol Verdi' })],
    })
    expect(r.material).toBe(true)
  })

  it('ownership percentage change is material', () => {
    const r = diffSigningState({ ...baseMMLLC, liveMemberRows: [aliceRow({ ownership_pct: 70 }), bobRow({ ownership_pct: 30 })] })
    expect(r.material).toBe(true)
  })

  it('added member is material', () => {
    const r = diffSigningState({
      ...baseMMLLC,
      liveMemberRows: [aliceRow({ ownership_pct: 50 }), bobRow({ ownership_pct: 30 }),
        { member_type: 'individual', full_name: 'Dan Neri', company_name: null, email: 'dan@e.com', contact_id: 'c-dan', ownership_pct: 20 }],
    })
    expect(r.material).toBe(true)
  })

  it('company member representative change is material', () => {
    const companyPinnedSigners: PinnedSignerRow[] = [
      { member_name: 'Rep One (for Acme LLC)', member_email: 'rep1@acme.com', contact_id: 'c-rep1' },
    ]
    const r = diffSigningState({
      agreementEntityType: 'MMLLC',
      pinnedMembers: [{ name: 'Acme LLC', email: null, ownership_pct: 100 }],
      pinnedSignerRows: companyPinnedSigners,
      liveMemberRows: [{
        member_type: 'company', full_name: null, company_name: 'Acme LLC', email: null,
        representative_name: 'Rep Two', representative_email: 'rep2@acme.com', contact_id: 'c-rep1', ownership_pct: 100,
      }],
    })
    expect(r.material).toBe(true)
  })
})

describe('diffSigningState — SMLLC shape boundary', () => {
  it('SMLLC agreement with one member row is NOT material (steady state)', () => {
    const r = diffSigningState({
      agreementEntityType: 'Single Member LLC',
      pinnedMembers: null,
      pinnedSignerRows: [],
      liveMemberRows: [aliceRow({ ownership_pct: 100 })],
    })
    expect(r.material).toBe(false)
  })

  it('SMLLC agreement with zero member rows is NOT material', () => {
    const r = diffSigningState({
      agreementEntityType: 'SMLLC', pinnedMembers: null, pinnedSignerRows: [], liveMemberRows: [],
    })
    expect(r.material).toBe(false)
  })

  it('SMLLC agreement that grew to 2 members IS material (conversion)', () => {
    const r = diffSigningState({
      agreementEntityType: 'Single Member LLC',
      pinnedMembers: null,
      pinnedSignerRows: [],
      liveMemberRows: [aliceRow(), bobRow()],
    })
    expect(r.material).toBe(true)
  })
})

describe('diffSigningState — Azarexa-shape MMLLC (members=[] , no signer rows)', () => {
  it('an MMLLC agreement pinned with no members but a live roster is material', () => {
    const r = diffSigningState({
      agreementEntityType: 'Multi Member LLC',
      pinnedMembers: [],
      pinnedSignerRows: [],
      liveMemberRows: [aliceRow(), bobRow()],
    })
    expect(r.material).toBe(true)
  })
})
