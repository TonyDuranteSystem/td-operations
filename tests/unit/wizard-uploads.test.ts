import { describe, it, expect } from 'vitest'
import {
  normalizeUploadValue,
  firstUploadPath,
  collectUploadPaths,
} from '@/lib/portal/wizard-uploads'

describe('normalizeUploadValue', () => {
  it('wraps a single string in an array', () => {
    expect(normalizeUploadValue('tax_return/x/bank_statements_ab12cd34_s.pdf')).toEqual([
      'tax_return/x/bank_statements_ab12cd34_s.pdf',
    ])
  })

  it('returns string members of an array', () => {
    expect(normalizeUploadValue(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('drops non-string array members', () => {
    expect(normalizeUploadValue(['a', 2, null, undefined, 'b'] as unknown)).toEqual(['a', 'b'])
  })

  it('returns [] for empty array, non-strings, null, undefined', () => {
    expect(normalizeUploadValue([])).toEqual([])
    expect(normalizeUploadValue(null)).toEqual([])
    expect(normalizeUploadValue(undefined)).toEqual([])
    expect(normalizeUploadValue(42)).toEqual([])
    expect(normalizeUploadValue(true)).toEqual([])
  })
})

describe('firstUploadPath', () => {
  it('returns the only path for a single string', () => {
    expect(firstUploadPath('formation/x/passport_owner_aa11bb22_p.png')).toBe(
      'formation/x/passport_owner_aa11bb22_p.png',
    )
  })

  it('returns the first path for an array', () => {
    expect(firstUploadPath(['first', 'second'])).toBe('first')
  })

  it('returns undefined for empty array / nullish / non-string', () => {
    expect(firstUploadPath([])).toBeUndefined()
    expect(firstUploadPath(null)).toBeUndefined()
    expect(firstUploadPath(undefined)).toBeUndefined()
    expect(firstUploadPath(123)).toBeUndefined()
  })
})

describe('collectUploadPaths', () => {
  it('collects single-string upload paths and ignores plain text fields', () => {
    const data = {
      owner_first_name: 'John',
      bank_statements: 'tax_return/john/bank_statements_ab12cd34_s.pdf',
      notes: 'hello world',
    }
    expect(collectUploadPaths(data)).toEqual([
      'tax_return/john/bank_statements_ab12cd34_s.pdf',
    ])
  })

  it('flattens array (multi-file) upload paths', () => {
    const data = {
      bank_statements: [
        'tax_return/john/bank_statements_a1_one.pdf',
        'tax_return/john/bank_statements_a2_two.csv',
      ],
      prior_year_return: ['tax_return/john/prior_year_return_b1_2024.pdf'],
    }
    expect(collectUploadPaths(data)).toEqual([
      'tax_return/john/bank_statements_a1_one.pdf',
      'tax_return/john/bank_statements_a2_two.csv',
      'tax_return/john/prior_year_return_b1_2024.pdf',
    ])
  })

  it('handles a mix of legacy string and new array fields', () => {
    const data = {
      passport_owner: 'formation/x/passport_owner_aa11bb22_p.png',
      bank_statements: ['tax_return/x/bank_statements_c1_a.csv'],
      company_name: 'Acme LLC',
    }
    expect(collectUploadPaths(data)).toEqual([
      'formation/x/passport_owner_aa11bb22_p.png',
      'tax_return/x/bank_statements_c1_a.csv',
    ])
  })

  it('ignores strings that are not wizard storage paths', () => {
    const data = {
      website: 'https://example.com/file.pdf',
      random: 'some/other/path.pdf',
      bank_statements: ['tax_return/x/bank_statements_c1_a.csv'],
    }
    expect(collectUploadPaths(data)).toEqual(['tax_return/x/bank_statements_c1_a.csv'])
  })

  it('returns [] when there are no uploads', () => {
    expect(collectUploadPaths({ a: 'x', b: 2, c: ['plain', 'text'] })).toEqual([])
  })

  it('matches every wizard-type prefix', () => {
    const data = {
      f: 'formation/x/passport_owner_1_a.png',
      o: 'onboarding/x/ein_letter_1_a.pdf',
      t1: 'tax/x/bank_statements_1_a.pdf',
      t2: 'tax_return/x/bank_statements_1_a.pdf',
      b: 'banking/x/proof_1_a.pdf',
      bp: 'banking_payset/x/proof_of_address_1_a.pdf',
      br: 'banking_relay/x/passport_image_1_a.pdf',
      i: 'itin/x/doc_1_a.pdf',
      c: 'closure/x/ein_letter_1_a.pdf',
      ci: 'company_info/x/passport_owner_1_a.pdf',
      w: 'wizard/x/field_1_a.pdf',
    }
    expect(collectUploadPaths(data)).toHaveLength(11)
  })
})

describe('repeater-flattened upload fields (pre-flight check, master plan §10.0)', () => {
  // The wizard's inline repeater FLATTENS sub-field values to top-level keys
  // ({repeater}_{idx}_{subfield} — wizard-client.tsx). Files inside repeater
  // rows therefore MUST be collected like any other field. If a repeater ever
  // stores rows as arrays-of-objects instead, this breaks silently — the same
  // bug class as the 2026-06-10 bucket incident. This test locks the contract.
  it('collects files from flattened per-bank repeater keys', () => {
    const data = {
      bank_accounts_0_bank_name: 'Mercury',
      bank_accounts_0_statements: ['tax/acct-1/statements_ab12_mercury.csv'],
      bank_accounts_1_bank_name: 'Some Unknown Bank',
      bank_accounts_1_statements: [
        'tax/acct-1/statements_cd34_unknown1.csv',
        'tax/acct-1/statements_ef56_unknown2.csv',
      ],
    }
    expect(collectUploadPaths(data)).toEqual([
      'tax/acct-1/statements_ab12_mercury.csv',
      'tax/acct-1/statements_cd34_unknown1.csv',
      'tax/acct-1/statements_ef56_unknown2.csv',
    ])
  })

  it('drops files if rows are nested objects (documents the limitation)', () => {
    // NOT a supported shape — repeaters must flatten. This test documents the
    // failure mode so a future nested-row design change can't pass unnoticed.
    const nested = {
      bank_accounts: [{ statements: ['tax/acct-1/statements_gh78_x.csv'] }],
    }
    expect(collectUploadPaths(nested as never)).toEqual([])
  })
})
