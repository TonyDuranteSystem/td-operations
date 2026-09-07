import { describe, it, expect } from 'vitest'
import { findExistingClientNewCalls } from '@/lib/leads/existing-client-new-calls'

const converted = { id: 'lead-1', full_name: 'Luca Gallacci', existing_client_contact_id: null, converted_to_contact_id: 'contact-1' }
const tagged = { id: 'lead-2', full_name: 'Davide Nobile', existing_client_contact_id: 'contact-2', converted_to_contact_id: null }

// Note: "is this lead actually an existing client" is filtered upstream by
// the caller's DB query (status=Converted OR existing_client_contact_id set)
// — this function only matches calls to whatever lead rows it's given.

describe('findExistingClientNewCalls', () => {
  it('matches a call linked directly by lead_id', () => {
    const r = findExistingClientNewCalls(
      [converted],
      [{ lead_id: 'lead-1', contact_id: null, created_at: '2026-09-01T00:00:00Z' }]
    )
    expect(r).toEqual([{ id: 'lead-1', full_name: 'Luca Gallacci', call_date: '2026-09-01T00:00:00Z' }])
  })

  it('matches a call linked only by contact_id (Circleback can skip lead_id)', () => {
    const r = findExistingClientNewCalls(
      [tagged],
      [{ lead_id: null, contact_id: 'contact-2', created_at: '2026-08-31T00:00:00Z' }]
    )
    expect(r).toEqual([{ id: 'lead-2', full_name: 'Davide Nobile', call_date: '2026-08-31T00:00:00Z' }])
  })

  it('ignores a call that matches neither a lead id nor a tagged contact id', () => {
    const r = findExistingClientNewCalls(
      [converted, tagged],
      [{ lead_id: 'lead-99', contact_id: 'contact-99', created_at: '2026-09-01T00:00:00Z' }]
    )
    expect(r).toEqual([])
  })

  it('collapses multiple calls for the same lead down to the single latest one', () => {
    const r = findExistingClientNewCalls(
      [converted],
      [
        { lead_id: 'lead-1', contact_id: null, created_at: '2026-08-20T00:00:00Z' },
        { lead_id: 'lead-1', contact_id: null, created_at: '2026-09-01T00:00:00Z' },
        { lead_id: 'lead-1', contact_id: null, created_at: '2026-08-25T00:00:00Z' },
      ]
    )
    expect(r).toEqual([{ id: 'lead-1', full_name: 'Luca Gallacci', call_date: '2026-09-01T00:00:00Z' }])
  })

  it('sorts multiple existing clients by most recent call first', () => {
    const r = findExistingClientNewCalls(
      [converted, tagged],
      [
        { lead_id: 'lead-1', contact_id: null, created_at: '2026-08-20T00:00:00Z' },
        { lead_id: null, contact_id: 'contact-2', created_at: '2026-09-01T00:00:00Z' },
      ]
    )
    expect(r.map(x => x.id)).toEqual(['lead-2', 'lead-1'])
  })

  it('skips a call with no created_at timestamp', () => {
    const r = findExistingClientNewCalls(
      [converted],
      [{ lead_id: 'lead-1', contact_id: null, created_at: null }]
    )
    expect(r).toEqual([])
  })

  it('returns nothing for empty inputs', () => {
    expect(findExistingClientNewCalls([], [])).toEqual([])
  })

  it('prefers lead_id match over a coincidental contact_id match on a different lead', () => {
    // Call is linked by lead_id to lead-1, even though its contact_id happens
    // to equal lead-2's tagged contact — lead_id, being the more specific
    // link, must win rather than double-counting or picking the wrong lead.
    const r = findExistingClientNewCalls(
      [converted, tagged],
      [{ lead_id: 'lead-1', contact_id: 'contact-2', created_at: '2026-09-01T00:00:00Z' }]
    )
    expect(r).toEqual([{ id: 'lead-1', full_name: 'Luca Gallacci', call_date: '2026-09-01T00:00:00Z' }])
  })
})
