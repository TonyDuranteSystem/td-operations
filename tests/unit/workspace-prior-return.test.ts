/**
 * Workspace prior-return answers (staff control + fork auto-derive) — the
 * records must be byte-compatible with the wizard's PriorReturnCaseRecord so
 * gate 2 reads both paths identically.
 */
import { describe, it, expect } from 'vitest'
import {
  buildWorkspacePriorReturnRecord,
  deriveFirstYearFromFormation,
  canStaffSetPriorReturn,
} from '@/lib/tax/workspace-prior-return'
import type { PriorReturnCaseRecord } from '@/lib/tax/prior-return-case'

describe('buildWorkspacePriorReturnRecord', () => {
  it('first_year with confirming formation date', () => {
    const r = buildWorkspacePriorReturnRecord({ choice: 'first_year', taxYear: 2024, formationDate: '2024-03-15', actor: 'qa@tonydurante.us' })
    expect(r).toMatchObject({ case: 'first_year', status: 'first_year', formation_date: '2024-03-15' })
    expect((r as { note: string }).note).toContain('confirms')
  })
  it('first_year contradicted by formation date → claim_mismatch, never silently trusted', () => {
    const r = buildWorkspacePriorReturnRecord({ choice: 'first_year', taxYear: 2024, formationDate: '2022-01-10', actor: 'qa@tonydurante.us' })
    expect(r).toMatchObject({ case: 'first_year', status: 'claim_mismatch' })
    expect((r as { note: string }).note).toContain('verify')
  })
  it('first_year without a formation date → accepted, flagged as not cross-checked', () => {
    const r = buildWorkspacePriorReturnRecord({ choice: 'first_year', taxYear: 2024, formationDate: null, actor: 'qa@tonydurante.us' })
    expect(r).toMatchObject({ case: 'first_year', status: 'first_year', formation_date: null })
    expect((r as { note: string }).note).toContain('not cross-checked')
  })
  it('never_filed is a timestamped declaration without the wizard upsell rail', () => {
    const r = buildWorkspacePriorReturnRecord({ choice: 'never_filed', taxYear: 2024, formationDate: null, actor: 'qa@tonydurante.us' })
    expect(r).toMatchObject({ case: 'never_filed', status: 'never_filed', cleanup_interest: 'No', declaration_accepted: true })
  })
})

describe('deriveFirstYearFromFormation (fork auto-derive)', () => {
  it('formed in the filing year → derived first_year', () => {
    const r = deriveFirstYearFromFormation('2024-06-01', 2024)
    expect(r).toMatchObject({ case: 'first_year', status: 'first_year' })
  })
  it('formed after the filing year → still first year (no prior return possible)', () => {
    expect(deriveFirstYearFromFormation('2025-01-05', 2024)).toMatchObject({ case: 'first_year' })
  })
  it('formed BEFORE the filing year → null (a prior return may exist)', () => {
    expect(deriveFirstYearFromFormation('2022-01-10', 2024)).toBeNull()
  })
  it('no formation date → null (positive confirmation only, no assumptions)', () => {
    expect(deriveFirstYearFromFormation(null, 2024)).toBeNull()
  })
})

describe('canStaffSetPriorReturn', () => {
  const rec = (over: Record<string, unknown>) => over as unknown as PriorReturnCaseRecord
  it('empty or failed → settable', () => {
    expect(canStaffSetPriorReturn(null)).toBe(true)
    expect(canStaffSetPriorReturn(rec({ case: 'missing', status: 'failed', error: 'x', recorded_at: 'now' }))).toBe(true)
  })
  it('staff-settable answers are replaceable', () => {
    expect(canStaffSetPriorReturn(rec({ case: 'first_year', status: 'first_year' }))).toBe(true)
    expect(canStaffSetPriorReturn(rec({ case: 'never_filed', status: 'never_filed' }))).toBe(true)
  })
  it('a validated/quarantined EXTRACTION is never replaceable from the staff control', () => {
    expect(canStaffSetPriorReturn(rec({ case: 'we_filed', status: 'validated' }))).toBe(false)
    expect(canStaffSetPriorReturn(rec({ case: 'filed_elsewhere', status: 'quarantined' }))).toBe(false)
    expect(canStaffSetPriorReturn(rec({ case: 'we_filed', status: 'on_file' }))).toBe(false)
  })
})
