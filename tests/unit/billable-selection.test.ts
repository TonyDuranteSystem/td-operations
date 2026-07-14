import { describe, it, expect } from 'vitest'
import { resolveBillableSelection, isSelectionLocked } from '@/lib/payments/billable-selection'

const SIGNED_FOR = ['ITIN Application']

describe('isSelectionLocked', () => {
  it('locks once signed or completed', () => {
    expect(isSelectionLocked('signed')).toBe(true)
    expect(isSelectionLocked('completed')).toBe(true)
    expect(isSelectionLocked('SIGNED')).toBe(true)
  })

  it('stays open before signing', () => {
    expect(isSelectionLocked('draft')).toBe(false)
    expect(isSelectionLocked('sent')).toBe(false)
    expect(isSelectionLocked('viewed')).toBe(false)
    expect(isSelectionLocked(null)).toBe(false)
    expect(isSelectionLocked(undefined)).toBe(false)
  })
})

describe('resolveBillableSelection', () => {
  // THE VULNERABILITY. /api/offers/create-checkout is public (token-only, no
  // session). A signed client could POST {selected_services: []} and pay less
  // than they contracted for.
  it('IGNORES the request body once signed — a client cannot pay less than they signed for', () => {
    expect(
      resolveBillableSelection({
        status: 'signed',
        storedSelection: SIGNED_FOR,
        requestedSelection: [], // the attack: "I select nothing, bill me nothing"
      }),
    ).toEqual(SIGNED_FOR)
  })

  it('ignores the body even when it tries to ADD services after signing', () => {
    expect(
      resolveBillableSelection({
        status: 'signed',
        storedSelection: SIGNED_FOR,
        requestedSelection: ['ITIN Application', 'Something They Never Signed For'],
      }),
    ).toEqual(SIGNED_FOR)
  })

  it('ignores the body on a completed offer too', () => {
    expect(
      resolveBillableSelection({
        status: 'completed',
        storedSelection: SIGNED_FOR,
        requestedSelection: [],
      }),
    ).toEqual(SIGNED_FOR)
  })

  it('signed with no stored selection bills required services only — never the body', () => {
    expect(
      resolveBillableSelection({
        status: 'signed',
        storedSelection: null,
        requestedSelection: ['Expensive Add-On'],
      }),
    ).toEqual([])
  })

  // Before signing the client is legitimately still choosing.
  it('honours the body BEFORE signing', () => {
    expect(
      resolveBillableSelection({
        status: 'viewed',
        storedSelection: [],
        requestedSelection: ['ITIN Application'],
      }),
    ).toEqual(['ITIN Application'])
  })

  it('falls back to the stored selection when the body sends nothing', () => {
    expect(
      resolveBillableSelection({
        status: 'sent',
        storedSelection: SIGNED_FOR,
        requestedSelection: undefined,
      }),
    ).toEqual(SIGNED_FOR)
  })

  it('is safe against junk input', () => {
    expect(
      resolveBillableSelection({
        status: 'signed',
        storedSelection: [1, 'ITIN Application', null, { x: 1 }],
        requestedSelection: 'not-an-array',
      }),
    ).toEqual(['ITIN Application'])

    expect(
      resolveBillableSelection({ status: null, storedSelection: null, requestedSelection: null }),
    ).toEqual([])
  })
})
