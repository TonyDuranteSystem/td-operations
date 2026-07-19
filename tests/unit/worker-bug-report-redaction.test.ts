/**
 * Identifiers must not travel from a client conversation into a team channel
 * (dev job 17459c25).
 *
 * These reports quote the staff message and the draft reply verbatim, and fire
 * automatically with no approval step. On Portal Chats and the Inbox those strings
 * routinely carry a real client's tax IDs, bank details and email addresses — while a
 * channel is read by more people than the one-client thread the text came from.
 */

import { describe, it, expect } from 'vitest'
import { redactIdentifiers } from '@/lib/team/redact-identifiers'

describe('redactIdentifiers', () => {
  it('removes SSN / ITIN', () => {
    expect(redactIdentifiers('his ITIN is 912-84-5567 ok')).toBe('his ITIN is [id] ok')
  })

  it('removes EIN', () => {
    expect(redactIdentifiers('EIN 83-4299021 filed')).toBe('EIN [ein] filed')
  })

  it('removes email addresses', () => {
    expect(redactIdentifiers('write to mario.rossi@example.com now')).toBe('write to [email] now')
  })

  it('removes IBAN-shaped strings', () => {
    expect(redactIdentifiers('IT60X0542811101000000123456 is the account')).toMatch(/\[iban\]/)
  })

  it('removes long digit runs (card / account numbers)', () => {
    expect(redactIdentifiers('card 4111 1111 1111 1111 charged')).toBe('card [number] charged')
    expect(redactIdentifiers('acct 000123456789 balance')).toBe('acct [number] balance')
  })

  it('handles several identifiers in one string', () => {
    const out = redactIdentifiers('ITIN 912-84-5567, EIN 83-4299021, mail a@b.com')
    expect(out).not.toMatch(/912-84-5567/)
    expect(out).not.toMatch(/83-4299021/)
    expect(out).not.toMatch(/a@b\.com/)
  })

  it('leaves ordinary prose intact — the diagnosis is the point of the report', () => {
    const prose = 'The formation deadline for the Wyoming filing has not been set yet.'
    expect(redactIdentifiers(prose)).toBe(prose)
  })

  it('does not mangle short numbers that carry meaning', () => {
    // Years, counts, amounts and stage numbers must survive or the report is unreadable.
    expect(redactIdentifiers('tax year 2025, stage 3, 12 clients')).toBe('tax year 2025, stage 3, 12 clients')
  })

  it('is safe on empty / nullish input', () => {
    expect(redactIdentifiers('')).toBe('')
    expect(redactIdentifiers(undefined as unknown as string)).toBe('')
  })
})
