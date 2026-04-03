'use server'

import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'

/**
 * Create an invoice via the unified system (writes to BOTH client_invoices + payments).
 * This replaces the old createInvoice from payments/invoice-actions.ts which only wrote to payments.
 */
export async function createUnifiedInvoiceDraft(input: {
  account_id: string
  description: string
  currency: 'USD' | 'EUR'
  due_date?: string
  message?: string
  items: Array<{ description: string; quantity: number; unit_price: number; amount: number; sort_order: number }>
}): Promise<ActionResult<{ id: string; invoice_number: string }>> {
  return safeAction(async () => {
    const { createUnifiedInvoice } = await import('@/lib/portal/unified-invoice')

    const result = await createUnifiedInvoice({
      account_id: input.account_id,
      line_items: input.items.map(item => ({
        description: item.description,
        unit_price: item.unit_price,
        quantity: item.quantity,
      })),
      currency: input.currency,
      due_date: input.due_date || undefined,
      message: input.message || undefined,
    })

    revalidatePath('/finance')
    revalidatePath('/payments')
    return { id: result.invoiceId, invoice_number: result.invoiceNumber }
  }, {
    action_type: 'create',
    table_name: 'client_invoices',
    account_id: input.account_id,
    summary: `Invoice created (Draft) via unified system`,
  })
}
