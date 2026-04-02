import { describe, it, expect } from 'vitest'

/**
 * Unit tests for the unified invoice module.
 * These test the module's type exports and interface contracts.
 * Full integration tests require a Supabase connection.
 */

describe('unified-invoice module', () => {
  it('exports createUnifiedInvoice function', async () => {
    const mod = await import('@/lib/portal/unified-invoice')
    expect(typeof mod.createUnifiedInvoice).toBe('function')
  })

  it('exports syncInvoiceStatus function', async () => {
    const mod = await import('@/lib/portal/unified-invoice')
    expect(typeof mod.syncInvoiceStatus).toBe('function')
  })

  it('UnifiedInvoiceInput interface requires at least account_id or contact_id', async () => {
    // Type-level contract: both are optional but at least one is required at runtime
    const mod = await import('@/lib/portal/unified-invoice')
    // This should throw because neither is provided
    await expect(
      mod.createUnifiedInvoice({
        line_items: [{ description: 'Test', unit_price: 100 }],
      })
    ).rejects.toThrow('at least one of account_id or contact_id required')
  })
})
