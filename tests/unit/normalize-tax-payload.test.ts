/**
 * Tests for normalizeTaxPayloadForPdf — the accountant-PDF payload cleanup:
 * folds flattened wizard repeater keys (members, related-party transactions)
 * into renderable arrays and drops exact-duplicate alias keys, so the
 * "Additional Information" section shows real extras instead of noise and
 * the accountant sees readable "Transaction N" blocks instead of raw codes.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeTaxPayloadForPdf,
  generateFormSummaryPDF,
  FORM_CONFIGS,
} from '@/lib/form-to-drive'

// Same shape as the real 2026-07-02 reported submission (synthetic values)
function rptPayload(): Record<string, unknown> {
  return {
    llc_name: 'SAMPLE AUTHORITY LLC',
    ein_number: '12-3456789',
    ein: '12-3456789',
    llc_ein: '12-3456789',
    owner_email: 'owner@example.com',
    email: 'owner@example.com',
    personal_email: 'owner@example.com',
    owner_phone: '+15550001111',
    phone: '+15550001111',
    owner_first_name: 'Test',
    first_name: 'Test',
    owner_country: 'Morocco',
    personal_country: 'Morocco',
    state_of_incorporation: 'Florida',
    state_of_formation: 'Florida',
    date_of_incorporation: '2025-03-27',
    formation_date: '2025-03-27',
    personal_expenses: 34659.79,
    has_related_party_transactions: 'Yes',
    related_party_transactions_count: 1,
    related_party_transactions_0_rpt_type: 'capital',
    related_party_transactions_0_rpt_amount: 3000,
    related_party_transactions_0_rpt_address: '2125 Sample Blvd, Miami, FL 33137',
    related_party_transactions_0_rpt_country: 'United States',
    related_party_transactions_0_rpt_direction: 'from_llc',
    related_party_transactions_0_rpt_vat_number: '41-4038072',
    related_party_transactions_0_rpt_description: 'Paying for owning a new business expenses',
    related_party_transactions_0_rpt_company_name: 'SAMPLE COMPLIANCE INC',
  }
}

describe('normalizeTaxPayloadForPdf — related-party transactions fold', () => {
  it('folds flattened rpt keys into a renderable array and drops the raw keys', () => {
    const out = normalizeTaxPayloadForPdf(rptPayload())
    const txs = out.related_party_transactions as Record<string, unknown>[]
    expect(txs).toHaveLength(1)
    expect(txs[0].rpt_company_name).toBe('SAMPLE COMPLIANCE INC')
    expect(txs[0].rpt_direction).toBe('from_llc')
    expect(txs[0].rpt_amount).toBe(3000)
    expect(out.related_party_transactions_count).toBeUndefined()
    expect(Object.keys(out).some(k => /^related_party_transactions_\d+_/.test(k))).toBe(false)
  })

  it('count is authoritative: orphaned higher-index keys are dropped after a fold', () => {
    const data = {
      ...rptPayload(),
      related_party_transactions_1_rpt_company_name: 'ORPHANED LEFTOVER INC',
    }
    const out = normalizeTaxPayloadForPdf(data)
    expect((out.related_party_transactions as unknown[]).length).toBe(1)
    expect(out.related_party_transactions_1_rpt_company_name).toBeUndefined()
  })

  it('keeps raw keys when the fold produces nothing (never hide data)', () => {
    const data: Record<string, unknown> = {
      related_party_transactions_count: 2,
      related_party_transactions_0_rpt_vat_number: 'only-a-vat-no-name-desc-amount',
    }
    const out = normalizeTaxPayloadForPdf(data)
    expect(out.related_party_transactions).toBeUndefined()
    expect(out.related_party_transactions_count).toBe(2)
    expect(out.related_party_transactions_0_rpt_vat_number).toBe('only-a-vat-no-name-desc-amount')
  })
})

describe('normalizeTaxPayloadForPdf — members fold (parity with legacy inline logic)', () => {
  it('folds member_N_ keys into members_list and drops the raw keys', () => {
    const data: Record<string, unknown> = {
      member_count: 2,
      member_0_member_type: 'individual',
      member_0_member_first_name: 'Anna',
      member_0_member_last_name: 'Rossi',
      member_0_member_citizenship: 'Italy',
      member_0_member_ownership_pct: 60,
      member_1_member_type: 'company',
      member_1_member_company_name: 'HOLDCO SRL',
      member_1_member_ownership_pct: 40,
    }
    const out = normalizeTaxPayloadForPdf(data)
    const members = out.members_list as Record<string, unknown>[]
    expect(members).toHaveLength(2)
    expect(members[0].member_name).toBe('Anna Rossi')
    expect(members[1].member_name).toBe('HOLDCO SRL')
    expect(out.member_count).toBeUndefined()
    expect(Object.keys(out).some(k => /^member_\d+_/.test(k))).toBe(false)
  })

  it('a stray company_name on an individual member never wins over their real name (Donato Ciardo, 2026-09-01)', () => {
    // Same real incident and same fix as lib/tax/financials-orchestration.ts's
    // extractWizardMembers — this file independently folds the same wizard
    // keys for the accountant-facing summary PDF and had the identical gap.
    const data: Record<string, unknown> = {
      member_count: 2,
      member_0_member_type: 'individual',
      member_0_member_first_name: 'Donato',
      member_0_member_last_name: 'Ciardo',
      member_0_member_ownership_pct: 99,
      member_0_member_company_name: 'Fast Consulting LLC',
      member_1_member_type: 'individual',
      member_1_member_first_name: 'Cristian',
      member_1_member_last_name: 'Ciardo',
      member_1_member_ownership_pct: 1,
    }
    const out = normalizeTaxPayloadForPdf(data)
    const members = out.members_list as Record<string, unknown>[]
    expect(members[0].member_name).toBe('Donato Ciardo')
    expect(members[1].member_name).toBe('Cristian Ciardo')
  })

  it('skips empty member slots (member_count over-reports)', () => {
    const data: Record<string, unknown> = {
      member_count: 3,
      member_0_member_first_name: 'Solo',
      member_0_member_last_name: 'Member',
    }
    const out = normalizeTaxPayloadForPdf(data)
    expect((out.members_list as unknown[]).length).toBe(1)
  })
})

describe('normalizeTaxPayloadForPdf — alias dedupe', () => {
  it('drops alias keys whose canonical twin has the identical value', () => {
    const out = normalizeTaxPayloadForPdf(rptPayload())
    for (const gone of ['ein', 'llc_ein', 'email', 'personal_email', 'phone', 'first_name', 'personal_country', 'formation_date', 'state_of_formation']) {
      expect(out[gone], `${gone} should be deduped`).toBeUndefined()
    }
    expect(out.ein_number).toBe('12-3456789')
    expect(out.owner_email).toBe('owner@example.com')
  })

  it('KEEPS an alias when its value diverges from the canonical key', () => {
    const out = normalizeTaxPayloadForPdf({
      owner_email: 'owner@example.com',
      email: 'different@example.com',
    })
    expect(out.email).toBe('different@example.com')
    expect(out.owner_email).toBe('owner@example.com')
  })

  it('KEEPS an alias when the canonical key is absent or empty', () => {
    const out = normalizeTaxPayloadForPdf({ email: 'only@example.com', owner_email: '' })
    expect(out.email).toBe('only@example.com')
  })

  it('does not mutate its input', () => {
    const data = rptPayload()
    const snapshot = JSON.stringify(data)
    normalizeTaxPayloadForPdf(data)
    expect(JSON.stringify(data)).toBe(snapshot)
  })
})

describe('normalized payload rendered through generateFormSummaryPDF', () => {
  async function extractText(bytes: Uint8Array): Promise<string> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise
    let text = ''
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent()
      for (const item of content.items) if ('str' in item) text += item.str + '\n'
    }
    return text
  }

  it('shows readable Transaction blocks instead of raw codes, no alias noise', async () => {
    const normalized = normalizeTaxPayloadForPdf(rptPayload())
    const bytes = await generateFormSummaryPDF(FORM_CONFIGS.tax_return, normalized, {
      token: 'test-normalized',
      submittedAt: '2026-07-02',
      companyName: 'SAMPLE AUTHORITY LLC',
      uploadCount: 0,
    })
    const text = await extractText(bytes)
    expect(text).toContain('Transaction 1')
    expect(text).toContain('Money paid TO this party')
    expect(text).toContain('Capital contribution / distribution')
    expect(text).not.toContain('from_llc')
    expect(text).not.toContain('Llc Ein')
    expect(text).not.toContain('Personal Email')
    expect(text).not.toContain('Related Party Transactions 0 Rpt')
  })
})
