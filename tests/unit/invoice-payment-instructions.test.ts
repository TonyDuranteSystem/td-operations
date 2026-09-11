import { describe, it, expect, vi } from 'vitest'
import { sanitizeInvoiceMessage } from '@/lib/portal/pay-token'

describe('sanitizeInvoiceMessage', () => {
  // Real production shape: a message built by the old, now-deleted
  // buildPaymentInstructions() — a staff note followed by a machine-generated
  // "Bank Transfer: ..." paragraph naming the account's actual selected bank
  // (Marcury - Choice Financial Group). Historical invoices still carry this
  // exact shape (dev jobs 1834af40 / 96e56d06) even though new invoices no
  // longer generate it — sanitizeInvoiceMessage is what protects them at
  // display time.
  const staffNote = 'First installment 2026 — LLC Annual Management.'
  const contaminatedMessage =
    `${staffNote}\n\nBank Transfer:\nBeneficiary: Tony Durante L.L.C.\nAccount: 202236384517\nRouting: 091311229\nBank: Marcury - Choice Financial Group\n\nCard payment available upon request.`

  it('strips the bank paragraph and the card sentence for a portal audience, keeping the real note', () => {
    const result = sanitizeInvoiceMessage(contaminatedMessage, 'portal')
    expect(result).toBe(staffNote)
    expect(result).not.toContain('Bank Transfer')
    expect(result).not.toContain('202236384517')
    expect(result).not.toContain('Card payment available')
  })

  it('leaves the message completely untouched for a no_portal audience', () => {
    const result = sanitizeInvoiceMessage(contaminatedMessage, 'no_portal')
    expect(result).toBe(contaminatedMessage)
    expect(result).toContain('Marcury - Choice Financial Group')
    expect(result).toContain('202236384517')
  })

  it('strips a card-only sentence (no bank paragraph) for a portal audience', () => {
    const cardOnly = `${staffNote}\n\nCard payment available upon request.`
    expect(sanitizeInvoiceMessage(cardOnly, 'portal')).toBe(staffNote)
  })

  it('returns an all-generated message (no real note) as an empty string for a portal audience', () => {
    const generatedOnly = '\n\nBank Transfer:\nBeneficiary: Tony Durante L.L.C.\nAccount: 202236384517\nRouting: 091311229\nBank: Marcury - Choice Financial Group'
    expect(sanitizeInvoiceMessage(generatedOnly, 'portal')).toBe('')
  })

  it('returns a clean staff note unchanged for a portal audience — nothing to strip', () => {
    expect(sanitizeInvoiceMessage(staffNote, 'portal')).toBe(staffNote)
  })

  it('returns an empty string for null/undefined/empty input, either audience', () => {
    expect(sanitizeInvoiceMessage(null, 'portal')).toBe('')
    expect(sanitizeInvoiceMessage(undefined, 'no_portal')).toBe('')
    expect(sanitizeInvoiceMessage('', 'portal')).toBe('')
  })
})

describe('createUnifiedInvoiceDraft — no longer bakes payment instructions into the stored message (dev jobs 1834af40 / 96e56d06)', () => {
  // The invoice PDF/email used to show bank details TWICE — once as a
  // free-text paragraph baked into payments.message at creation time, once
  // again in the PDF's own structured Bank Details block — and the baked-in
  // paragraph bypassed every audience check downstream, so portal-tier
  // clients (who should see zero bank details) got them anyway. The fix
  // moves bank-detail rendering entirely to send/render time (resolveBankDetails
  // + sanitizeInvoiceMessage, gated by resolveInvoiceAudience); this wrapper
  // must now store ONLY what staff actually typed.
  async function callWithMockedDeps(input: Parameters<typeof import('@/app/(dashboard)/finance/actions').createUnifiedInvoiceDraft>[0]) {
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
    }))
    vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }))
    vi.doMock('@/lib/server-action', () => ({
      safeAction: vi.fn(async (fn: () => Promise<unknown>) => {
        const data = await fn()
        return { success: true, data }
      }),
    }))

    const { createUnifiedInvoiceDraft } = await import('@/app/(dashboard)/finance/actions')
    await createUnifiedInvoiceDraft(input)

    vi.doUnmock('@/lib/portal/td-invoice')
    vi.doUnmock('@/lib/invoice-auto-send')
    vi.doUnmock('next/cache')
    vi.doUnmock('@/lib/server-action')

    return mockCreateTDInvoice
  }

  it('sends only the staff-typed message, even with bank_transfer selected and a specific bank chosen', async () => {
    const mockCreateTDInvoice = await callWithMockedDeps({
      account_id: 'acct-1',
      description: 'Service',
      currency: 'USD',
      message: 'First installment 2026 — LLC Annual Management.',
      bank_preference: 'settings_bank:xyz',
      payment_method: 'bank_transfer',
      items: [{ description: 'Consulting', quantity: 1, unit_price: 1000, amount: 1000, sort_order: 0 }],
    })

    expect(mockCreateTDInvoice).toHaveBeenCalledTimes(1)
    const callArg = mockCreateTDInvoice.mock.calls[0][0] as { message?: string }
    expect(callArg.message).toBe('First installment 2026 — LLC Annual Management.')
    expect(callArg.message).not.toContain('Bank Transfer')
    expect(callArg.message).not.toContain('Card payment')
  })

  it('sends undefined when staff left the message blank — never falls back to a generated paragraph', async () => {
    const mockCreateTDInvoice = await callWithMockedDeps({
      account_id: 'acct-1',
      description: 'Service',
      currency: 'USD',
      payment_method: 'both',
      items: [{ description: 'Consulting', quantity: 1, unit_price: 1000, amount: 1000, sort_order: 0 }],
    })

    const callArg = mockCreateTDInvoice.mock.calls[0][0] as { message?: string }
    expect(callArg.message).toBeUndefined()
  })
})
