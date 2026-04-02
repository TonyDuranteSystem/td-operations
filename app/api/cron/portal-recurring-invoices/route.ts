export const dynamic = 'force-dynamic'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { createUnifiedInvoice } from '@/lib/portal/unified-invoice'
import { createPortalNotification } from '@/lib/portal/notifications'
import { NextResponse } from 'next/server'

/**
 * GET /api/cron/portal-recurring-invoices
 * Daily cron job: finds recurring invoices where recurring_next_date <= today,
 * creates a copy with new dates, advances recurring_next_date.
 */
export async function GET() {
  const today = new Date().toISOString().split('T')[0]

  // Find recurring invoices due for generation
  const { data: recurring } = await supabaseAdmin
    .from('client_invoices')
    .select('*, client_invoice_items(*)')
    .not('recurring_frequency', 'is', null)
    .lte('recurring_next_date', today)
    .or(`recurring_end_date.is.null,recurring_end_date.gte.${today}`)
    .in('status', ['Sent', 'Paid']) // Only generate from active templates

  if (!recurring || recurring.length === 0) {
    return NextResponse.json({ generated: 0 })
  }

  let generated = 0

  for (const template of recurring) {
    try {
      // Calculate due date from template's issue→due offset
      let dueDate: string | undefined
      if (template.due_date && template.issue_date) {
        const daysDiff = Math.round(
          (new Date(template.due_date).getTime() - new Date(template.issue_date).getTime()) / 86400000
        )
        dueDate = new Date(Date.now() + daysDiff * 86400000).toISOString().split('T')[0]
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = (template.client_invoice_items as any[]) ?? []
      if (items.length === 0) continue

      // Create unified invoice (writes to BOTH client_invoices + payments with FK link)
      const result = await createUnifiedInvoice({
        account_id: template.account_id || undefined,
        contact_id: template.contact_id || undefined,
        customer_id: template.customer_id || undefined,
        line_items: items.map((item: { description: string; quantity: number; unit_price: number }) => ({
          description: item.description,
          unit_price: item.unit_price,
          quantity: item.quantity,
        })),
        currency: (template.currency || 'USD') as 'USD' | 'EUR',
        due_date: dueDate,
        notes: template.notes || undefined,
        message: template.message || undefined,
        recurring_parent_id: template.id,
      })

      // Advance recurring_next_date
      const nextDate = calculateNextDate(template.recurring_next_date, template.recurring_frequency)
      await supabaseAdmin
        .from('client_invoices')
        .update({ recurring_next_date: nextDate })
        .eq('id', template.id)

      // Create notification
      await createPortalNotification({
        account_id: template.account_id,
        type: 'invoice',
        title: `Recurring invoice generated: ${result.invoiceNumber}`,
        body: 'A new invoice has been automatically created from your recurring template.',
        link: '/portal/invoices',
      })

      generated++
    } catch (err) {
      console.error(`Failed to generate recurring invoice for template ${template.id}:`, err)
    }
  }

  return NextResponse.json({ generated, checked: recurring.length })
}

function calculateNextDate(currentDate: string, frequency: string): string {
  const date = new Date(currentDate)
  switch (frequency) {
    case 'monthly':
      date.setMonth(date.getMonth() + 1)
      break
    case 'quarterly':
      date.setMonth(date.getMonth() + 3)
      break
    case 'yearly':
      date.setFullYear(date.getFullYear() + 1)
      break
  }
  return date.toISOString().split('T')[0]
}
