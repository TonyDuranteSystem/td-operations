import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { pickTaxRecordForPipeline } from '@/lib/tax/pick-tax-record'
import { taxReturnYear } from '@/lib/flows/resolve-flows'

const R = (id: string, tax_year: number | null, status: string | null = 'Extension Filed') => ({ id, status, tax_year })

describe('pickTaxRecordForPipeline', () => {
  it('picks the record of the pipeline\'s own tax year, not the calendar year', () => {
    // 2026: the work is for 2025. The company also holds a (wrong-status) 2026 record — it must NOT be chosen.
    const out = pickTaxRecordForPipeline([R('r25', 2025), R('r26', 2026, 'Not Invoiced')], 2025)
    expect(out).toEqual({ kind: 'record', row: R('r25', 2025) })
  })
  it('next season the same rule picks 2026 (a 2027 calendar year would have found nothing)', () => {
    const out = pickTaxRecordForPipeline([R('r25', 2025, 'TR Filed'), R('r26', 2026, 'Paid - Not Started')], 2026)
    expect(out.kind === 'record' && out.row.id).toBe('r26')
  })
  it('does not fall back to an older or newer year', () => {
    const out = pickTaxRecordForPipeline([R('r24', 2024), R('r26', 2026)], 2025)
    expect(out.kind).toBe('none')
    expect(out.kind === 'none' && out.reason).toBe('the company has no 2025 tax record')
  })
  it('says why when there is no year to look for', () => {
    expect(pickTaxRecordForPipeline([R('r25', 2025)], null)).toEqual({ kind: 'none', reason: 'the pipeline has no date to read its tax year from' })
    expect(pickTaxRecordForPipeline([R('r25', 2025)], undefined).kind).toBe('none')
    expect(pickTaxRecordForPipeline([R('r25', 2025)], Number.NaN).kind).toBe('none')
  })
  it('refuses to choose between two records of the same year', () => {
    const out = pickTaxRecordForPipeline([R('a', 2025), R('b', 2025)], 2025)
    expect(out).toEqual({ kind: 'none', reason: 'the company has 2 tax records for 2025' })
  })
  it('handles no rows at all', () => {
    expect(pickTaxRecordForPipeline([], 2025).kind).toBe('none')
    expect(pickTaxRecordForPipeline(null, 2025).kind).toBe('none')
  })
  it('ignores a record with no tax year', () => {
    expect(pickTaxRecordForPipeline([R('x', null)], 2025).kind).toBe('none')
  })
})

describe('the pipeline year used by the sync is the same one the chat tab shows', () => {
  it('a pipeline opened in 2026 -> the 2025 record; opened in 2027 -> the 2026 record', () => {
    const rows = [R('r25', 2025), R('r26', 2026)]
    const y26 = taxReturnYear({ due_date: null, created_at: '2026-03-20T00:00:00Z', stage_entered_at: '2026-10-07T15:55:00Z' })
    const y27 = taxReturnYear({ due_date: null, created_at: '2027-02-01T00:00:00Z', stage_entered_at: '2027-10-07T15:55:00Z' })
    expect(pickTaxRecordForPipeline(rows, y26)).toMatchObject({ kind: 'record', row: { id: 'r25' } })
    expect(pickTaxRecordForPipeline(rows, y27)).toMatchObject({ kind: 'record', row: { id: 'r26' } })
  })
})

describe('wiring: the Tax Return sync in advanceServiceDelivery', () => {
  const src = readFileSync('lib/service-delivery.ts', 'utf8')
  // Code only — the comments above the block explain the old calendar-year rule and so name it.
  const block = src
    .slice(src.indexOf('// 9. Tax Return'), src.indexOf('// 10+11. RA Renewal'))
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')
  it('chooses the record with pickTaxRecordForPipeline and the pipeline\'s tax year', () => {
    expect(block).toContain('pickTaxRecordForPipeline(')
    expect(block).toContain('taxReturnYear(delivery)')
  })
  it('no longer reads the calendar year, and reports a record it could not choose', () => {
    expect(block).not.toMatch(/new Date\(\)\.getFullYear\(\)/)
    expect(block).toContain('Tax return NOT synced')
  })
  it('never pulls a TR Filed record back, and says so', () => {
    expect(block).toContain('tr.status === "TR Filed"')
    expect(block).toContain('the record is already TR Filed')
  })
  it('still skips when the tax-return tab itself made the move', () => {
    expect(block).toContain('actor !== "tax-return-tab"')
  })
})
