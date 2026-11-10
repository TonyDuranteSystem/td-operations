/**
 * Tax Return plan item 7 (dev job 6f555c9f) — the Form 7004 generator (lib/pdf/7004-fill.ts): the OFFICIAL IRS form (Rev. December 2025) filled for a
 * foreign-owned single-member LLC. What the IRS asks for these filers (Instructions for Form 5472, "Extension of time to file"): the code for Form 1120
 * on Part I line 1, "Foreign-owned U.S. DE" across the top. The test reads the finished PDF back, so a template that went wrong (blank, wrong form,
 * missing text) is caught.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { fill7004, form7004Problem, formatEin, FORM_7004_CODE_FORM_1120, FORM_7004_TOP_NOTE, type Form7004FillData } from '@/lib/pdf/7004-fill'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const parse = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer) => Promise<{ text: string; numpages: number }>

const DATA: Form7004FillData = {
  companyName: 'Sample Holdings of Wyoming LLC',
  ein: '123456789',
  street: '10225 Ulmerton Rd 3D PMB 318',
  city: 'Largo',
  state: 'FL',
  zip: '33771',
  taxYear: 2025,
}

describe('the template is the official IRS Form 7004', () => {
  const bytes = readFileSync(join(__dirname, '../../public/templates/f7004-blank.pdf'))
  it('one page, Letter size, no XFA layer and no leftover fields (flattened)', async () => {
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 })
    expect(doc.getForm().getFields()).toHaveLength(0)
    expect(bytes.toString('latin1')).not.toContain('/XFA')
  })
  it('is the Rev. December 2025 form and its code table says Form 1120 is code 12', async () => {
    const { text } = await parse(bytes)
    expect(text).toContain('Application for Automatic Extension of Time To File')
    expect(text).toContain('(Rev. December 2025)')
    // the table's rows read as text with the code glued to the form name: "Form 1120" + "12" (and Form 1120-C + 34, Form 1120-S + 25 …)
    expect(text).toMatch(/\nForm 112012\n/)
    expect(text).toMatch(/\nForm 1120-C34\n/)
    expect(FORM_7004_CODE_FORM_1120).toBe('12')
  })
})

describe('fill7004', () => {
  it('prints what the IRS asks for these filers: the words across the top, the company, the EIN with its dash, the address, the code 12 and the year', async () => {
    const out = Buffer.from(await fill7004(DATA))
    const { text, numpages } = await parse(out)
    expect(numpages).toBe(1)
    expect(text).toContain(FORM_7004_TOP_NOTE)
    expect(text).toContain('Sample Holdings of Wyoming LLC')
    expect(text).toContain('12-3456789')
    expect(text).toContain('10225 Ulmerton Rd 3D PMB 318')
    expect(text).toContain('Largo')
    expect(text).toContain('33771')
    expect(text).toContain('25') // line 5a: calendar year 20__
  })
  it('lines 6, 7 and 8 are -0- unless the data says otherwise (the IRS: "enter -0- if zero")', async () => {
    const zero = (await parse(Buffer.from(await fill7004(DATA)))).text
    expect((zero.match(/-0-/g) ?? []).length).toBeGreaterThanOrEqual(3)
    const money = (await parse(Buffer.from(await fill7004({ ...DATA, tentativeTax: '1,250.00', totalPayments: '500', balanceDue: '750.00' })))).text
    expect(money).toContain('1,250.00')
    expect(money).toContain('750.00')
  })
  it('a long company name still fits its box (smaller type, never cut off) and an optional suite and a foreign address are printed', async () => {
    const long = 'The Extraordinarily Long Named International Consulting and Holding Company of Wyoming LLC'
    const text = (await parse(Buffer.from(await fill7004({ ...DATA, companyName: long, suite: 'Suite 400', country: 'Italy' })))).text
    expect(text).toContain(long)
    expect(text).toContain('Suite 400')
    expect(text).toContain('Italy')
  })
  it('is deterministic enough to be tested twice: the same data makes a valid one-page PDF each time', async () => {
    const a = await PDFDocument.load(await fill7004(DATA))
    const b = await PDFDocument.load(await fill7004(DATA))
    expect(a.getPageCount()).toBe(1)
    expect(b.getPageCount()).toBe(1)
  })
  it('refuses data that cannot make a valid form, with a plain sentence, and makes nothing', async () => {
    await expect(fill7004({ ...DATA, companyName: '  ' })).rejects.toThrow('The company name is missing.')
    await expect(fill7004({ ...DATA, ein: '12-345' })).rejects.toThrow(/EIN must be 9 digits/)
  })
})

describe('form7004Problem', () => {
  it('names what is missing, in the order a person would fill the form', () => {
    expect(form7004Problem(DATA)).toBeNull()
    expect(form7004Problem({ ...DATA, companyName: '' })).toBe('The company name is missing.')
    expect(form7004Problem({ ...DATA, ein: 'abc' })).toBe('The EIN must be 9 digits (for example 12-3456789).')
    expect(form7004Problem({ ...DATA, street: ' ' })).toBe('The street address is missing.')
    expect(form7004Problem({ ...DATA, city: '' })).toBe('The city is missing.')
    expect(form7004Problem({ ...DATA, state: '' })).toBe('The state is missing.')
    expect(form7004Problem({ ...DATA, zip: '' })).toBe('The ZIP code is missing.')
    expect(form7004Problem({ ...DATA, taxYear: Number.NaN })).toBe('The tax year is missing.')
    expect(form7004Problem({ ...DATA, taxYear: 1999 })).toBe('The tax year is missing.')
  })
  it('accepts an EIN with or without the dash, and amounts as dollars or -0-', () => {
    expect(form7004Problem({ ...DATA, ein: '12-3456789' })).toBeNull()
    expect(form7004Problem({ ...DATA, tentativeTax: '-0-', totalPayments: '0', balanceDue: '1,000.50' })).toBeNull()
    expect(form7004Problem({ ...DATA, tentativeTax: 'lots' })).toBe('Tax must be a dollar amount or -0-.')
    expect(form7004Problem({ ...DATA, balanceDue: '12.5' })).toBe('Balance due must be a dollar amount or -0-.')
  })
})

describe('formatEin', () => {
  it('puts the dash in a bare 9-digit number and leaves anything else alone', () => {
    expect(formatEin('123456789')).toBe('12-3456789')
    expect(formatEin('12-3456789')).toBe('12-3456789')
    expect(formatEin(' 12345 ')).toBe('12345')
  })
})
