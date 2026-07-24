/**
 * The supported-state check must accept the shape accounts ACTUALLY store.
 *
 * A guard was added to the portal's self-service Operating Agreement flow that
 * compared `accounts.state_of_formation` directly against OA_SUPPORTED_STATES
 * (two-letter codes). Production stores the FULL NAME — 201 Wyoming, 38 Florida,
 * 29 New Mexico, 21 Delaware, versus exactly one "NM". The guard would therefore
 * have refused 289 of 291 accounts with "we can't generate this automatically",
 * permanently, with no way for the client to clear it.
 *
 * These cases are the real production values, so a future refactor that drops
 * the normalisation fails here instead of silently disabling self-service.
 */
import { describe, it, expect } from 'vitest'
import { normalizeOAState, OA_SUPPORTED_STATES } from '@/lib/types/oa-templates'

const isSupported = (raw: string | null | undefined) =>
  OA_SUPPORTED_STATES.includes(normalizeOAState(raw) as (typeof OA_SUPPORTED_STATES)[number])

describe('OA supported-state check', () => {
  it('accepts the full state names production actually stores', () => {
    for (const stored of ['Wyoming', 'Florida', 'New Mexico', 'Delaware']) {
      expect(isSupported(stored), `"${stored}" is a real stored value and must be accepted`).toBe(true)
    }
  })

  it('accepts the two-letter codes too', () => {
    for (const stored of ['WY', 'FL', 'NM', 'DE']) {
      expect(isSupported(stored), `"${stored}" must be accepted`).toBe(true)
    }
  })

  it('is tolerant of case and stray whitespace', () => {
    for (const stored of ['  wyoming ', 'new mexico', 'Fl', ' de']) {
      expect(isSupported(stored), `"${stored}" must be accepted`).toBe(true)
    }
  })

  it('still refuses a genuinely unsupported state', () => {
    for (const stored of ['Massachusetts', 'MA', 'Texas', 'California']) {
      expect(isSupported(stored), `"${stored}" must be refused`).toBe(false)
    }
  })

  it('refuses a missing state rather than passing it through', () => {
    expect(isSupported(null)).toBe(false)
    expect(isSupported(undefined)).toBe(false)
    expect(isSupported('')).toBe(false)
  })
})
