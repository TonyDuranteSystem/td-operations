/**
 * The VAT / Partita IVA field on a customer is for European customers only (Antonio 2026-10-10, dev job 1a23f5f1).
 * It stays optional; a hint under the field says so, in English and Italian.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { t } from '@/lib/portal/i18n'

const newForm = readFileSync('components/portal/new-customer-form.tsx', 'utf8')
const editPage = readFileSync('app/portal/customers/[id]/page.tsx', 'utf8')

describe('VAT field hint', () => {
  it('says EU only and optional, in English and Italian', () => {
    expect(t('customers.vat', 'en')).toBe('VAT / Partita IVA (EU only)')
    expect(t('customers.vatHint', 'en')).toMatch(/Optional.*European Union.*US customers/)
    expect(t('customers.vat', 'it')).toBe('Partita IVA / VAT (solo UE)')
    expect(t('customers.vatHint', 'it')).toMatch(/Facoltativa.*Unione Europea.*USA/)
  })
  it('the new-customer form and the edit page both show it, and the field is not required', () => {
    expect(newForm).toContain("hint={t('customers.vatHint')}")
    expect(editPage).toContain("hint={t('customers.vatHint')}")
    expect(newForm).toContain('vat_number: form.vat_number.trim() || null')
  })
})
