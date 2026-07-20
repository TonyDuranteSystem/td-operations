/**
 * Fixed-choice values differing only by capitalisation.
 *
 * MEASURED, 2026-07-20. The assistant proposed logging a conversation with direction
 * "inbound"; the schema wanted "Inbound"; the proposal was rejected; it retried, ran out
 * of turns, and asked the staff member to do the job by hand. From the outside that read
 * as the assistant refusing to act. Older agent tools had always been forgiving here —
 * catalog tools, the much larger set, never were.
 *
 * The important half of these tests is what it must NOT do: mapping a near-synonym would
 * quietly turn a proposal into a different action than the card described.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { coerceBridgeParams } from '@/lib/ai-agent/bridge-param-coercion'

// Shaped like a real catalog tool's schema.
const SHAPE = {
  account_id: z.string(),
  channel: z.enum(['phone', 'email', 'whatsapp', 'portal']),
  direction: z.enum(['Inbound', 'Outbound']).optional(),
  status: z.enum(['To Do', 'In Progress', 'Done']).optional().default('To Do'),
  priority: z.enum(['Low', 'Normal', 'High']).nullable(),
  summary: z.string().optional(),
  count: z.number().optional(),
}

describe('capitalisation is corrected', () => {
  it('fixes the exact case that broke it — "inbound" → "Inbound"', () => {
    const out = coerceBridgeParams(SHAPE, { direction: 'inbound' })
    expect(out.direction).toBe('Inbound')
  })

  it('works through optional, default and nullable wrappers', () => {
    // The real schemas wrap enums in all three; missing a wrapper silently does nothing.
    const out = coerceBridgeParams(SHAPE, {
      direction: 'OUTBOUND',
      status: 'in progress',
      priority: 'high',
    })
    expect(out.direction).toBe('Outbound')
    expect(out.status).toBe('In Progress')
    expect(out.priority).toBe('High')
  })

  it('ignores surrounding whitespace', () => {
    expect(coerceBridgeParams(SHAPE, { direction: '  Inbound ' }).direction).toBe('Inbound')
  })

  it('leaves an already-correct value exactly as it is', () => {
    const params = { direction: 'Inbound', channel: 'phone' }
    expect(coerceBridgeParams(SHAPE, params)).toEqual(params)
  })
})

describe('it must NOT guess', () => {
  it('leaves a near-synonym alone so validation still rejects it', () => {
    // "incoming" is not a spelling of "Inbound". Mapping it would make the proposal do
    // something the card never said — the one failure mode worse than being rejected.
    expect(coerceBridgeParams(SHAPE, { direction: 'incoming' }).direction).toBe('incoming')
  })

  it('does not match on a prefix or partial word', () => {
    expect(coerceBridgeParams(SHAPE, { direction: 'in' }).direction).toBe('in')
    expect(coerceBridgeParams(SHAPE, { channel: 'phon' }).channel).toBe('phon')
  })

  it('does not touch free text, ids or numbers', () => {
    const params = {
      account_id: 'CC7A02D2-731A-4EC4-BF29-D7372ADF1559',
      summary: 'Spoke with the client. INBOUND call.',
      count: 3,
    }
    expect(coerceBridgeParams(SHAPE, params)).toEqual(params)
  })

  it('leaves non-string values on a fixed-choice field alone', () => {
    expect(coerceBridgeParams(SHAPE, { direction: 42 }).direction).toBe(42)
    expect(coerceBridgeParams(SHAPE, { direction: null }).direction).toBeNull()
  })
})

describe('edges', () => {
  it('returns the params untouched when the tool has no schema', () => {
    const params = { direction: 'inbound' }
    expect(coerceBridgeParams(undefined, params)).toEqual(params)
  })

  it('ignores params the schema does not mention', () => {
    expect(coerceBridgeParams(SHAPE, { unknown_field: 'whatever' }).unknown_field).toBe('whatever')
  })

  it('does not mutate the caller’s object', () => {
    // The original params are hashed for the integrity check elsewhere; mutating them
    // in place would change a value out from under a caller that still holds it.
    const params = { direction: 'inbound' }
    const out = coerceBridgeParams(SHAPE, params)
    expect(params.direction).toBe('inbound')
    expect(out.direction).toBe('Inbound')
  })

  it('handles an empty params object', () => {
    expect(coerceBridgeParams(SHAPE, {})).toEqual({})
  })
})
