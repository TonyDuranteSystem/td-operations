import { describe, it, expect } from 'vitest'
import { pickPayerPerson } from '@/lib/invoices/payer-person'

describe('pickPayerPerson — the same person every time', () => {
  it('prefers an owner-role contact (case-insensitive), then the primary, then the lowest id', () => {
    expect(pickPayerPerson([
      { contact_id: 'c3', role: 'Member', is_primary: true },
      { contact_id: 'c2', role: 'co-owner', is_primary: false },
    ])).toBe('c2')
    expect(pickPayerPerson([
      { contact_id: 'c9', role: 'Member', is_primary: false },
      { contact_id: 'c5', role: 'Member', is_primary: true },
    ])).toBe('c5')
    expect(pickPayerPerson([
      { contact_id: 'c9', role: null },
      { contact_id: 'c4', role: null },
    ])).toBe('c4')
  })

  it('does not depend on the order the database returned the rows in', () => {
    const rows = [
      { contact_id: 'b', role: 'Owner', is_primary: false },
      { contact_id: 'a', role: 'Owner', is_primary: false },
      { contact_id: 'c', role: 'Owner', is_primary: true },
    ]
    const forward = pickPayerPerson(rows)
    const backward = pickPayerPerson([...rows].reverse())
    expect(forward).toBe('c')
    expect(backward).toBe(forward)
  })

  it('an owner who is not primary still beats a primary non-owner', () => {
    expect(pickPayerPerson([
      { contact_id: 'p', role: 'Manager', is_primary: true },
      { contact_id: 'o', role: 'Owner', is_primary: false },
    ])).toBe('o')
  })

  it('does not change the list it was given, and answers null for no people', () => {
    const rows = [{ contact_id: 'z', role: null }, { contact_id: 'a', role: null }]
    pickPayerPerson(rows)
    expect(rows[0].contact_id).toBe('z')
    expect(pickPayerPerson([])).toBeNull()
  })
})
