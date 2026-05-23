import { describe, it, expect } from 'vitest'
import { syncInvoiceToQB, syncPaymentToQB, syncVoidToQB } from '@/lib/qb-sync'

/**
 * QuickBooks was decommissioned (dev_task eca3ce5c). The three sync functions
 * must no-op unless QB_ENABLED === "true". The vitest env does not set
 * QB_ENABLED, so every function early-returns BEFORE touching the DB or the QB
 * API — proving no QuickBooks traffic happens on invoice send / bank match / void.
 */
describe('QB kill-switch — sync functions no-op when disabled', () => {
  it('syncInvoiceToQB no-ops', async () => {
    const r = await syncInvoiceToQB('any-payment-id')
    expect(r.success).toBe(false)
    expect(r.error).toBe('QuickBooks sync disabled')
  })

  it('syncPaymentToQB no-ops', async () => {
    const r = await syncPaymentToQB('any-payment-id')
    expect(r.success).toBe(false)
    expect(r.error).toBe('QuickBooks sync disabled')
  })

  it('syncVoidToQB no-ops', async () => {
    const r = await syncVoidToQB('any-payment-id')
    expect(r.success).toBe(false)
    expect(r.error).toBe('QuickBooks sync disabled')
  })
})
