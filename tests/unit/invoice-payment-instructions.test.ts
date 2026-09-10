import { describe, it, expect, vi } from 'vitest'
import { buildPaymentInstructions } from '@/lib/invoice-auto-send'

describe('buildPaymentInstructions', () => {
  it('names the specific bank it was given — regression pin for the wrong-bank bug (dev job 1834af40)', () => {
    // Real production shape: the account's actual selected bank (Marcury -
    // Choice Financial Group), NOT the hardcoded default (Relay) that used
    // to get baked in regardless of which bank was actually chosen.
    const actualSelectedBank = {
      label: 'Marcury - Choice Financial Group — USD',
      accountHolder: 'Tony Durante L.L.C.',
      bankName: 'Marcury - Choice Financial Group',
      iban: null,
      swiftBic: null,
      accountNumber: '202236384517',
      routingNumber: '091311229',
    }
    const instructions = buildPaymentInstructions(actualSelectedBank, 'bank_transfer')
    expect(instructions).toContain('Marcury - Choice Financial Group')
    expect(instructions).toContain('202236384517')
    expect(instructions).toContain('091311229')
    // Must never silently name a different bank than the one it was given.
    expect(instructions).not.toContain('Relay')
    expect(instructions).not.toContain('200000306770')
  })

  it('prefers IBAN/BIC formatting when the bank has an IBAN', () => {
    const eurBank = {
      label: 'EUR Wire — EUR',
      accountHolder: 'Tony Durante L.L.C.',
      bankName: 'Banking Circle S.A.',
      iban: 'DK8989000023658198',
      swiftBic: 'SXPYDKKK',
      accountNumber: null,
      routingNumber: null,
    }
    const instructions = buildPaymentInstructions(eurBank, 'bank_transfer')
    expect(instructions).toContain('IBAN: DK8989000023658198')
    expect(instructions).toContain('BIC: SXPYDKKK')
    expect(instructions).not.toContain('Account:')
    expect(instructions).not.toContain('Routing:')
  })

  it('falls back to account/routing formatting when there is no IBAN', () => {
    const usBank = {
      label: 'Chase JP Morgan — USD',
      accountHolder: 'Tony Durante L.L.C.',
      bankName: 'Chase JP Morgan',
      iban: null,
      swiftBic: null,
      accountNumber: '893993920',
      routingNumber: '267084131',
    }
    const instructions = buildPaymentInstructions(usBank, 'bank_transfer')
    expect(instructions).toContain('Account: 893993920')
    expect(instructions).toContain('Routing: 267084131')
    expect(instructions).not.toContain('IBAN:')
  })

  it('omits the bank-transfer block entirely when paymentMethod is "card"', () => {
    const usBank = {
      label: 'Chase JP Morgan — USD',
      accountHolder: 'Tony Durante L.L.C.',
      bankName: 'Chase JP Morgan',
      iban: null,
      swiftBic: null,
      accountNumber: '893993920',
      routingNumber: '267084131',
    }
    const instructions = buildPaymentInstructions(usBank, 'card')
    expect(instructions).not.toContain('Bank Transfer')
    expect(instructions).toContain('Card payment available upon request.')
  })

  it('includes both blocks for "both"', () => {
    const usBank = {
      label: 'Chase JP Morgan — USD',
      accountHolder: 'Tony Durante L.L.C.',
      bankName: 'Chase JP Morgan',
      iban: null,
      swiftBic: null,
      accountNumber: '893993920',
      routingNumber: '267084131',
    }
    const instructions = buildPaymentInstructions(usBank, 'both')
    expect(instructions).toContain('Bank Transfer')
    expect(instructions).toContain('Card payment available upon request.')
  })

  it('produces no bank-transfer block when the selected bank has neither IBAN nor account number (e.g. a Zelle-type entry)', () => {
    const zelleEntry = {
      label: 'Zelle — USD',
      accountHolder: 'Tony Durante L.L.C.',
      bankName: null,
      iban: null,
      swiftBic: null,
      accountNumber: null,
      routingNumber: null,
    }
    const instructions = buildPaymentInstructions(zelleEntry, 'both')
    expect(instructions).not.toContain('Bank Transfer')
    expect(instructions).toContain('Card payment available upon request.')
  })
})

describe('createUnifiedInvoiceDraft — bank-details wiring (dev job 1834af40)', () => {
  // buildPaymentInstructions() alone being correct isn't enough — the bug this
  // pins was a WIRING gap: createUnifiedInvoiceDraft resolved the correct bank
  // via resolveBankDetails() but a leftover hand-rolled block still read the
  // OLD field names (bankDetails.beneficiary/.account_number/.routing_number/
  // .bank_name) against the new resolver's camelCase shape (.accountHolder/
  // .accountNumber/.routingNumber/.bankName) — silently producing "undefined"
  // in the printed instructions. Caught by lint (no-unused-vars on the
  // now-dead buildPaymentInstructions import), not by the pure-function tests
  // above, which is exactly why this test exercises the real call path.
  it('threads the resolved bank straight into the message sent to createTDInvoice', async () => {
    vi.resetModules()
    const mockCreateTDInvoice = vi.fn(async () => ({
      paymentId: 'pay-1',
      expenseId: 'exp-1',
      invoiceNumber: 'INV-000001',
      total: 1000,
      status: 'Draft',
    }))
    vi.doMock('@/lib/portal/td-invoice', () => ({ createTDInvoice: mockCreateTDInvoice }))
    vi.doMock('@/lib/invoice-auto-send', () => ({
      fetchSettingsBanks: vi.fn(async () => []),
      selectSettingsBank: vi.fn(() => null),
      resolveBankDetails: vi.fn(async () => ({
        label: 'Marcury - Choice Financial Group — USD',
        accountHolder: 'Tony Durante L.L.C.',
        bankName: 'Marcury - Choice Financial Group',
        iban: null,
        swiftBic: null,
        accountNumber: '202236384517',
        routingNumber: '091311229',
      })),
      buildPaymentInstructions,
    }))
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }))
    vi.doMock('@/lib/server-action', () => ({
      safeAction: vi.fn(async (fn: () => Promise<unknown>) => {
        const data = await fn()
        return { success: true, data }
      }),
    }))

    const { createUnifiedInvoiceDraft } = await import('@/app/(dashboard)/finance/actions')
    await createUnifiedInvoiceDraft({
      account_id: 'acct-1',
      description: 'Service',
      currency: 'USD',
      bank_preference: 'settings_bank:xyz',
      payment_method: 'bank_transfer',
      items: [{ description: 'Consulting', quantity: 1, unit_price: 1000, amount: 1000, sort_order: 0 }],
    })

    expect(mockCreateTDInvoice).toHaveBeenCalledTimes(1)
    const callArg = mockCreateTDInvoice.mock.calls[0][0] as { message?: string }
    expect(callArg.message).toContain('Marcury - Choice Financial Group')
    expect(callArg.message).toContain('202236384517')
    expect(callArg.message).not.toContain('undefined')

    vi.doUnmock('@/lib/portal/td-invoice')
    vi.doUnmock('@/lib/invoice-auto-send')
    vi.doUnmock('next/cache')
    vi.doUnmock('@/lib/server-action')
  })
})
