export const dynamic = 'force-dynamic'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { generateInvoiceNumber } from '@/lib/portal/invoice-number'
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
      const invoiceNumber = await generateInvoiceNumber(template.account_id)

      // Calculate new dates
      const issueDate = today
      let dueDate: string | null = null
      if (template.due_date && template.issue_date) {
        const daysDiff = Math.round(
          (new Date(template.due_date).getTime() - new Date(template.issue_date).getTime()) / 86400000
        )
        dueDate = new Date(Date.now() + daysDiff * 86400000).toISOString().split('T')[0]
      }

      // Create new invoice
      const { data: newInvoice, error } = await supabaseAdmin
        .from('client_invoices')
        .insert({
          account_id: template.account_id,
          customer_id: template.customer_id,
          invoice_number: invoiceNumber,
          status: 'Draft',
          currency: template.currency,
          subtotal: template.subtotal,
          discount: template.discount,
          total: template.total,
          issue_date: issueDate,
          due_date: dueDate,
          notes: template.notes,
          message: template.message,
          recurring_parent_id: template.id,
        })
        .select('id')
        .single()

      if (error || !newInvoice) continue

      // Copy line items
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = (template.client_invoice_items as any[]) ?? []
      if (items.length > 0) {
        await supabaseAdmin.from('client_invoice_items').insert(
          items.map((item: { description: string; quantity: number; unit_price: number; amount: number; sort_order: number }) => ({
            invoice_id: newInvoice.id,
            description: item.description,
            quantity: item.quantity,
            unit_price: item.unit_price,
            amount: item.amount,
            sort_order: item.sort_order,
          }))
        )
      }

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
        title: `Recurring invoice generated: ${invoiceNumber}`,
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
