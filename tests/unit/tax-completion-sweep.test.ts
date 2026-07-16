import { describe, it, expect } from 'vitest'
import {
  formatSweepAlert,
  isSweepEligible,
  parseChainResults,
  sweepAttempts,
  SWEEP_ATTEMPTS_KEY,
  SWEEP_CUTOFF_ISO,
  SWEEP_GRACE_MINUTES,
} from '@/lib/tax/completion-sweep'

// Time-travel pattern: explicit `now`, no system clock mocking.
const NOW = new Date('2026-08-01T12:00:00Z')
const hoursBeforeNow = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

const externalRow = (overrides: Partial<Parameters<typeof isSweepEligible>[0]> = {}) => ({
  status: 'completed',
  completed_at: hoursBeforeNow(2),
  review_status: null,
  token: 'acme-consulting-llc-2025',
  ...overrides,
})

describe('isSweepEligible', () => {
  it('selects an external completed row past the grace window with no marker', () => {
    expect(isSweepEligible(externalRow(), NOW)).toBe(true)
  })

  it('rejects rows whose chain marker is already set — any value', () => {
    for (const rs of ['submitted', 'under_review', 'revision_requested', 'approved', 'confirmed', 'resubmitted']) {
      expect(isSweepEligible(externalRow({ review_status: rs }), NOW), rs).toBe(false)
    }
  })

  it('rejects non-completed rows', () => {
    expect(isSweepEligible(externalRow({ status: 'pending' }), NOW)).toBe(false)
    expect(isSweepEligible(externalRow({ status: 'reviewed' }), NOW)).toBe(false)
    expect(isSweepEligible(externalRow({ status: null }), NOW)).toBe(false)
  })

  it('rejects portal-wizard rows by missing completed_at (their actual shape)', () => {
    expect(isSweepEligible(externalRow({ completed_at: null }), NOW)).toBe(false)
  })

  it('rejects portal-wizard rows by token prefix even if completed_at appears', () => {
    expect(isSweepEligible(externalRow({ token: 'portal-acme-consulting-llc-2025' }), NOW)).toBe(false)
  })

  it('rejects rows inside the grace window (direct fire may be in flight)', () => {
    const justNow = new Date(NOW.getTime() - (SWEEP_GRACE_MINUTES - 1) * 60_000).toISOString()
    expect(isSweepEligible(externalRow({ completed_at: justNow }), NOW)).toBe(false)
  })

  it('accepts a row exactly one minute past the grace window', () => {
    const pastGrace = new Date(NOW.getTime() - (SWEEP_GRACE_MINUTES + 1) * 60_000).toISOString()
    expect(isSweepEligible(externalRow({ completed_at: pastGrace }), NOW)).toBe(true)
  })

  it('rejects historical rows before the cutoff (the 13 pre-existing spring rows)', () => {
    expect(isSweepEligible(externalRow({ completed_at: '2026-04-28T14:06:52Z' }), NOW)).toBe(false)
    const justBeforeCutoff = new Date(Date.parse(SWEEP_CUTOFF_ISO) - 1000).toISOString()
    expect(isSweepEligible(externalRow({ completed_at: justBeforeCutoff }), NOW)).toBe(false)
  })

  it('rejects garbage timestamps instead of throwing', () => {
    expect(isSweepEligible(externalRow({ completed_at: 'not-a-date' }), NOW)).toBe(false)
  })
})

describe('parseChainResults', () => {
  it('reports success when the review_status marker step ran ok', () => {
    const { markerOk, errorSteps } = parseChainResults({
      ok: true,
      results: [
        { step: 'email_notification', status: 'ok' },
        { step: 'review_status', status: 'ok', detail: 'review_status -> submitted' },
      ],
    })
    expect(markerOk).toBe(true)
    expect(errorSteps).toEqual([])
  })

  it('reports failure when the marker step errored, and surfaces every errored step', () => {
    const { markerOk, errorSteps } = parseChainResults({
      results: [
        { step: 'email_notification', status: 'error', detail: 'smtp down' },
        { step: 'review_status', status: 'error', detail: 'constraint' },
      ],
    })
    expect(markerOk).toBe(false)
    expect(errorSteps).toHaveLength(2)
  })

  it('surfaces step errors even when the marker succeeded (e.g. drive_save)', () => {
    const { markerOk, errorSteps } = parseChainResults({
      results: [
        { step: 'review_status', status: 'ok' },
        { step: 'drive_save', status: 'error', detail: 'bucket miss' },
      ],
    })
    expect(markerOk).toBe(true)
    expect(errorSteps).toEqual(['drive_save: bucket miss'])
  })

  it('treats a missing/garbage body as failure, never throws', () => {
    expect(parseChainResults(null).markerOk).toBe(false)
    expect(parseChainResults({}).markerOk).toBe(false)
    expect(parseChainResults({ results: 'nope' }).markerOk).toBe(false)
    expect(parseChainResults(undefined).errorSteps.length).toBeGreaterThan(0)
  })
})

describe('sweepAttempts', () => {
  it('reads the counter from financials_meta', () => {
    expect(sweepAttempts({ [SWEEP_ATTEMPTS_KEY]: 2 })).toBe(2)
  })

  it('defaults to 0 for missing/empty/garbage meta', () => {
    expect(sweepAttempts(null)).toBe(0)
    expect(sweepAttempts(undefined)).toBe(0)
    expect(sweepAttempts({})).toBe(0)
    expect(sweepAttempts({ [SWEEP_ATTEMPTS_KEY]: 'abc' })).toBe(0)
    expect(sweepAttempts({ [SWEEP_ATTEMPTS_KEY]: -3 })).toBe(0)
  })
})

describe('formatSweepAlert', () => {
  it('returns null when there is nothing to alert', () => {
    expect(formatSweepAlert([], true)).toBeNull()
    expect(formatSweepAlert([], false)).toBeNull()
  })

  it('opens with the warning triangle and mentions Luca', () => {
    const msg = formatSweepAlert([{ company: 'Acme LLC', tax_year: 2025, outcome: 'dry_run_candidate' }], true)
    expect(msg).toMatch(/^⚠️ @Luca/)
    expect(msg).toContain('Acme LLC (2025)')
    expect(msg).toContain('watch mode')
  })

  it('describes each outcome distinctly in live mode', () => {
    const msg = formatSweepAlert(
      [
        { company: 'A LLC', tax_year: 2025, outcome: 'rescued' },
        { company: 'B LLC', tax_year: 2025, outcome: 'fire_failed', detail: 'http 500', attempt: 2 },
        { company: 'C LLC', tax_year: 2025, outcome: 'gave_up' },
      ],
      false,
    )
    expect(msg).toContain('re-ran it successfully')
    expect(msg).toContain('attempt 2/3 FAILED: http 500')
    expect(msg).toContain('GAVE UP')
    expect(msg).toMatch(/^⚠️ @Luca/)
  })

  it('omits the year suffix when tax_year is null', () => {
    const msg = formatSweepAlert([{ company: 'Acme LLC', tax_year: null, outcome: 'gave_up' }], false)
    expect(msg).toContain('• Acme LLC —')
  })
})
