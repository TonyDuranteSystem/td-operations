/**
 * Layout regression tests for the form-to-drive summary PDF.
 *
 * Origin: 2026-07-02 — the accountant reported the Tax_Data PDF for an SMLLC
 * client had values overprinting long labels ("Personal Expenses Paid Through
 * LLC (USD):" is wider than the fixed x=200 value column), making the numbers
 * unreadable. The geometric test here parses the generated PDF with pdfjs and
 * asserts no two text items on the same line overlap horizontally — so any
 * future label/column change that reintroduces a collision fails CI.
 */
import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import {
  generateFormSummaryPDF,
  wrapByWidth,
  valueStartX,
  PDF_LAYOUT,
  FORM_CONFIGS,
} from '@/lib/form-to-drive'

// ─── valueStartX ───

describe('valueStartX', () => {
  it('keeps the aligned value column for short labels', () => {
    expect(valueStartX(50, 100)).toBe(PDF_LAYOUT.valueColumnX)
  })

  it('pushes the value past the end of a long label plus the gap', () => {
    // Label ends at 50 + 192 = 242 (the real "Personal Expenses..." width)
    expect(valueStartX(50, 192)).toBe(50 + 192 + PDF_LAYOUT.labelValueGap)
  })

  it('never lets the value start before the label ends', () => {
    for (const w of [0, 50, 150, 149.9, 150.1, 200, 300, 500]) {
      expect(valueStartX(50, w)).toBeGreaterThanOrEqual(50 + w + PDF_LAYOUT.labelValueGap)
    }
  })
})

// ─── wrapByWidth ───

describe('wrapByWidth', () => {
  const widthOf = (s: string) => s.length * 5 // 5pt per char stub

  it('returns a single line when the text fits', () => {
    expect(wrapByWidth('hello world', 100, widthOf)).toEqual(['hello world'])
  })

  it('wraps greedily and every line fits maxWidth', () => {
    const text = 'aaaa bbbb cccc dddd eeee ffff'
    const lines = wrapByWidth(text, 50, widthOf) // 10 chars per line
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(50)
    expect(lines.join(' ')).toBe(text)
  })

  it('hard-breaks a single word wider than maxWidth', () => {
    const lines = wrapByWidth('abcdefghijklmnopqrst', 50, widthOf)
    for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(50)
    expect(lines.join('')).toBe('abcdefghijklmnopqrst')
  })

  it('collapses runs of whitespace and handles empty input', () => {
    expect(wrapByWidth('', 50, widthOf)).toEqual([])
    expect(wrapByWidth('   ', 50, widthOf)).toEqual([])
    expect(wrapByWidth('a\n\n b\t c', 100, widthOf)).toEqual(['a b c'])
  })

  it('wraps with real Helvetica metrics without overflowing', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const measure = (s: string) => font.widthOfTextAtSize(s, 9)
    const text = 'WWWW MMMM '.repeat(30) // wide glyphs, worst case
    const maxW = PDF_LAYOUT.rightMargin - PDF_LAYOUT.wrapIndentX
    for (const line of wrapByWidth(text.trim(), maxW, measure)) {
      expect(measure(line)).toBeLessThanOrEqual(maxW)
    }
  })
})

// ─── Geometric overlap regression on the real generator ───

/**
 * Parse a generated PDF and assert that no two text items that share a
 * baseline overlap horizontally, and nothing crosses the right margin.
 */
async function assertNoOverlaps(pdfBytes: Uint8Array) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: pdfBytes.slice() }).promise
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const byLine = new Map<number, { x: number; endX: number; str: string }[]>()
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue
      const y = Math.round(item.transform[5])
      const x = item.transform[4]
      const row = byLine.get(y) ?? []
      row.push({ x, endX: x + item.width, str: item.str })
      byLine.set(y, row)
    }
    for (const [y, items] of Array.from(byLine.entries())) {
      items.sort((a, b) => a.x - b.x)
      for (let i = 1; i < items.length; i++) {
        const prev = items[i - 1]
        const curr = items[i]
        expect(
          prev.endX <= curr.x + 0.5,
          `page ${p} y=${y}: "${prev.str}" (ends ${prev.endX.toFixed(1)}) overlaps "${curr.str}" (starts ${curr.x.toFixed(1)})`
        ).toBe(true)
      }
      for (const item of items) {
        expect(
          item.endX <= PDF_LAYOUT.rightMargin + 20,
          `page ${p} y=${y}: "${item.str}" crosses the right margin (ends ${item.endX.toFixed(1)})`
        ).toBe(true)
      }
    }
  }
}

describe('generateFormSummaryPDF layout', () => {
  it('SMLLC financials: values never overprint long labels (2026-07-02 bug)', async () => {
    // Synthetic payload with the same shape as the real reported submission:
    // long SMLLC labels + numeric values + flattened related-party keys.
    const data: Record<string, unknown> = {
      llc_name: 'SAMPLE VERY LONG COMPANY NAME AUTHORITY LLC',
      ein_number: '12-3456789',
      state_of_incorporation: 'Florida',
      date_of_incorporation: '2025-03-27',
      principal_product_service: 'Translation of drivers licenses to 12 languages',
      has_us_business_activities: 'No',
      owner_first_name: 'Test',
      owner_last_name: 'Owner',
      owner_email: 'owner@example.com',
      formation_costs: 0,
      bank_contributions: 0,
      distributions_withdrawals: 30710.09,
      personal_expenses: 34659.79,
      has_related_party_transactions: 'Yes',
      related_party_transactions_count: 1,
      related_party_transactions_0_rpt_type: 'capital',
      related_party_transactions_0_rpt_amount: 3000,
      related_party_transactions_0_rpt_address: '2125 Sample Boulevard Ste 204 #24685 Miami, FL 33137 United States',
      related_party_transactions_0_rpt_country: 'United States',
      related_party_transactions_0_rpt_direction: 'from_llc',
      related_party_transactions_0_rpt_vat_number: '41-4038072',
      related_party_transactions_0_rpt_description: 'Paying for owning a new business expenses',
      related_party_transactions_0_rpt_company_name: 'SAMPLE COMPLIANCE INC',
    }
    const bytes = await generateFormSummaryPDF(FORM_CONFIGS.tax_return, data, {
      token: 'test-smllc-2026',
      submittedAt: '2026-07-01',
      companyName: 'SAMPLE VERY LONG COMPANY NAME AUTHORITY LLC',
      uploadCount: 0,
    })
    expect(bytes.length).toBeGreaterThan(0)
    await assertNoOverlaps(bytes)
  })

  it('every form config renders every field without overlaps', async () => {
    for (const [formType, config] of Object.entries(FORM_CONFIGS)) {
      const data: Record<string, unknown> = {}
      for (const section of config.sections) {
        for (const field of section.fields) {
          data[field.key] = `Sample value for ${field.key} 12345.67`
        }
      }
      const bytes = await generateFormSummaryPDF(config, data, {
        token: `test-${formType}`,
        submittedAt: '2026-07-01',
        companyName: 'Test Company LLC',
        uploadCount: 2,
      })
      expect(bytes.length).toBeGreaterThan(0)
      await assertNoOverlaps(bytes)
    }
  })

  it('nested member arrays (MMLLC K-1 roster) render without overlaps', async () => {
    const data: Record<string, unknown> = {
      llc_name: 'MMLLC Test Company LLC',
      members_list: [
        {
          member_name: 'A Member With A Rather Long Full Name Indeed',
          member_kind: 'person',
          member_citizenship: 'Italy',
          member_residence_country: 'Italy',
          member_address: 'Via di Esempio Molto Lunga 123, Interno 45, 00100 Roma RM, Italia',
          member_itin_status: 'have',
          member_itin: '900-123456',
          member_ownership_pct: 50,
          member_company_owner: 'Someone Behind The Company With A Long Name',
        },
        {
          member_name: 'B Member',
          member_kind: 'company',
          member_ownership_pct: 50,
        },
      ],
    }
    const bytes = await generateFormSummaryPDF(FORM_CONFIGS.tax_return, data, {
      token: 'test-mmllc',
      submittedAt: '2026-07-01',
      companyName: 'MMLLC Test Company LLC',
      uploadCount: 0,
    })
    await assertNoOverlaps(bytes)
  })

  it('survives values with newlines, tabs, and very long unbroken strings', async () => {
    const data: Record<string, unknown> = {
      llc_name: 'Edge Case LLC',
      principal_product_service: 'line one\nline two\n\ttabbed',
      smllc_additional_comments: 'x'.repeat(400),
      website_url: `https://example.com/${'a'.repeat(200)}`,
    }
    const bytes = await generateFormSummaryPDF(FORM_CONFIGS.tax_return, data, {
      token: 'test-edge',
      submittedAt: '2026-07-01',
      companyName: 'Edge Case LLC',
      uploadCount: 0,
    })
    await assertNoOverlaps(bytes)
  })
})
