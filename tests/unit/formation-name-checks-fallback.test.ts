/**
 * lib/operations/formation-name-checks.ts::getOrInitNameChecks — fallback
 * coverage (dev job 9a9c5cf5, live production incident: Francesco Lussignoli's
 * LLC Name Approval panel showed NO candidate names at all — blocking staff
 * from taking the next action — because his wizard_progress row never got
 * created and this function had no fallback).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let sdFixture: Record<string, unknown> | null = null
let wizardProgressFixture: { data: Record<string, unknown> } | null = null
let formationSubmissionFixture: { submitted_data: Record<string, unknown> } | null = null
let writtenChecks: unknown = null

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'service_deliveries') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: sdFixture, error: null }),
          update: (row: Record<string, unknown>) => {
            writtenChecks = row.name_checks
            return { eq: () => Promise.resolve({ data: null, error: null }) }
          },
        }
        return chain
      }
      if (table === 'wizard_progress') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: wizardProgressFixture, error: null }),
        }
        return chain
      }
      if (table === 'formation_submissions') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: formationSubmissionFixture, error: null }),
        }
        return chain
      }
      const fallback = {
        select: () => fallback,
        eq: () => fallback,
        in: () => fallback,
        order: () => fallback,
        limit: () => fallback,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      }
      return fallback
    },
  },
}))

import { getOrInitNameChecks } from '@/lib/operations/formation-name-checks'

const SD_ID = 'sd-1'
const CONTACT_ID = 'contact-1'

beforeEach(() => {
  sdFixture = {
    id: SD_ID,
    contact_id: CONTACT_ID,
    account_id: null,
    name_checks: [],
    service_type: 'Company Formation',
    due_date: null,
    stage_entered_at: null,
    created_at: '2026-09-01T00:00:00Z',
  }
  wizardProgressFixture = null
  formationSubmissionFixture = null
  writtenChecks = null
})

describe('getOrInitNameChecks', () => {
  it('initializes from wizard_progress when it exists (existing behavior, unchanged)', async () => {
    wizardProgressFixture = { data: { llc_name_1: 'Alpha LLC', llc_name_2: 'Beta LLC' } }
    formationSubmissionFixture = { submitted_data: { llc_name_1: 'WRONG (should not be used)' } }
    const checks = await getOrInitNameChecks(SD_ID)
    expect(checks.map((c) => c.name)).toContain('Alpha LLC')
    expect(checks.map((c) => c.name)).not.toContain('WRONG (should not be used)')
  })

  it('falls back to formation_submissions when wizard_progress has no row for this contact (dev job 9a9c5cf5)', async () => {
    wizardProgressFixture = null
    formationSubmissionFixture = { submitted_data: { llc_name_1: 'NCLT LLC', llc_name_2: 'NCLT BRANDS LLC' } }
    const checks = await getOrInitNameChecks(SD_ID)
    expect(checks.map((c) => c.name)).toContain('NCLT LLC')
    expect(checks.length).toBeGreaterThan(0)
  })

  it('persists the fallback-derived names onto the service_delivery (one-time init)', async () => {
    wizardProgressFixture = null
    formationSubmissionFixture = { submitted_data: { llc_name_1: 'NCLT LLC' } }
    await getOrInitNameChecks(SD_ID)
    expect(writtenChecks).not.toBeNull()
    expect(Array.isArray(writtenChecks)).toBe(true)
  })

  it('returns an empty list (not an error) when NEITHER source has data', async () => {
    wizardProgressFixture = null
    formationSubmissionFixture = null
    const checks = await getOrInitNameChecks(SD_ID)
    expect(checks).toEqual([])
  })

  it('does not query the fallback table when wizard_progress already has data (no wasted read)', async () => {
    wizardProgressFixture = { data: { llc_name_1: 'Alpha LLC' } }
    const checks = await getOrInitNameChecks(SD_ID)
    expect(checks.map((c) => c.name)).toContain('Alpha LLC')
  })
})
