import { describe, it, expect, vi, beforeEach } from 'vitest'

// The overage alert is the safety net for a stale Stripe page. The only place a person
// sees it today is the hourly admin digest, which shows the company and the FIRST 80
// characters of the message — so the message must lead with the invoice and the figures.
let insertedRows: Array<Record<string, unknown>>
let insertError: { message: string } | null
let invoiceLookup: { invoice_number: string | null; account_id: string | null } | null
let alreadyOpenRows: Array<{ id: string }>

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'payments') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: invoiceLookup }) }) }) }
      }
      // portal_issues
      return {
        select: () => ({ eq: () => ({ is: () => ({ contains: () => ({ limit: async () => ({ data: alreadyOpenRows }) }) }) }) }),
        insert: async (row: Record<string, unknown>) => {
          insertedRows.push(row)
          return { error: insertError }
        },
      }
    },
  },
}))

import { raiseCardFeeOverageIssue } from '@/lib/finance/card-fee-issues'

beforeEach(() => {
  insertedRows = []
  insertError = null
  alreadyOpenRows = []
  invoiceLookup = { invoice_number: 'INV-002941', account_id: 'acc-1' }
})

describe('raiseCardFeeOverageIssue', () => {
  it('the first 80 characters (all the digest shows) name the invoice, the figures and the action', async () => {
    await raiseCardFeeOverageIssue({ paymentId: 'p1', base: 500, charged: 1050, gatewayPaymentId: 'pi_1' })
    const msg = String(insertedRows[0].error_message)
    expect(msg.slice(0, 80)).toContain('INV-002941')
    expect(msg.slice(0, 80)).toContain('charged 1050')
    expect(msg.slice(0, 80)).toContain('owed 500')
    expect(msg.slice(0, 80)).toContain('refund the surplus')
  })

  it('links the row to the company so the digest does not say "Unknown"', async () => {
    await raiseCardFeeOverageIssue({ paymentId: 'p1', base: 500, charged: 1050, gatewayPaymentId: 'pi_1' })
    expect(insertedRows[0].account_id).toBe('acc-1')
    expect(insertedRows[0].client_notified).toBe(false) // staff-only
  })

  it('still raises the alert when the invoice lookup finds nothing', async () => {
    invoiceLookup = null
    await raiseCardFeeOverageIssue({ paymentId: 'p1', base: 500, charged: 1050, gatewayPaymentId: 'pi_1' })
    expect(insertedRows).toHaveLength(1)
    expect(String(insertedRows[0].error_message)).toMatch(/^Invoice card overpay/)
    expect(insertedRows[0].account_id).toBeNull()
  })

  it('is deduped on the gateway payment id', async () => {
    alreadyOpenRows = [{ id: 'existing' }]
    await raiseCardFeeOverageIssue({ paymentId: 'p1', base: 500, charged: 1050, gatewayPaymentId: 'pi_1' })
    expect(insertedRows).toHaveLength(0)
  })

  it('a failed insert is logged, not silent (supabase-js returns errors instead of throwing)', async () => {
    insertError = { message: 'permission denied' }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await raiseCardFeeOverageIssue({ paymentId: 'p1', base: 500, charged: 1050, gatewayPaymentId: 'pi_1' })
    expect(spy).toHaveBeenCalledWith('[card-fee-issues] failed to raise issue:', 'permission denied')
    spy.mockRestore()
  })
})
