/**
 * Cron: Invoice Overdue Detection
 * Schedule: daily at 9am ET via Vercel cron
 *
 * Marks Sent invoices as Overdue when due_date has passed.
 * Sends auto-reminders:
 *   - 1st reminder after 7 days overdue
 *   - 2nd reminder after 14 days overdue (+ email to Antonio)
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET(req: NextRequest) {
  try {
    // Verify cron secret
    const authHeader = req.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const today = new Date().toISOString().split('T')[0]
    const results = { marked_overdue: 0, reminders_sent: 0, errors: [] as string[] }

    // 1. Mark Sent invoices as Overdue when due_date < today
    const { data: newOverdue, error: markErr } = await supabaseAdmin
      .from('payments')
      .update({
        invoice_status: 'Overdue',
        updated_at: new Date().toISOString(),
      })
      .eq('invoice_status', 'Sent')
      .lt('due_date', today)
      .select('id, invoice_number, account_id, amount, currency, due_date')

    if (markErr) {
      console.error('[invoice-overdue] Mark overdue error:', markErr.message)
      results.errors.push(`Mark overdue: ${markErr.message}`)
    } else {
      results.marked_overdue = newOverdue?.length ?? 0
      if (newOverdue && newOverdue.length > 0) {
        console.log(`[invoice-overdue] Marked ${newOverdue.length} invoices as Overdue:`,
          newOverdue.map(i => i.invoice_number).join(', '))
      }
    }

    // 2. Auto-send reminders for overdue invoices
    // 7+ days overdue with 0 reminders → 1st reminder
    // 14+ days overdue with 1 reminder → 2nd reminder
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    const fourteenDaysAgo = new Date()
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14)

    const { data: overdueInvoices } = await supabaseAdmin
      .from('payments')
      .select('id, invoice_number, due_date, reminder_count, account_id, amount, currency')
      .eq('invoice_status', 'Overdue')
      .order('due_date', { ascending: true })

    if (overdueInvoices) {
      for (const inv of overdueInvoices) {
        const dueDate = new Date(inv.due_date + 'T00:00:00')
        const daysOverdue = Math.floor((Date.now() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
        const reminderCount = inv.reminder_count ?? 0

        let shouldRemind = false
        if (daysOverdue >= 14 && reminderCount < 2) shouldRemind = true
        else if (daysOverdue >= 7 && reminderCount < 1) shouldRemind = true

        if (shouldRemind) {
          try {
            // Call the remind API internally
            const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL
              ? `https://${process.env.VERCEL_URL}`
              : 'http://localhost:3000'

            const remindRes = await fetch(`${baseUrl}/api/invoices/${inv.id}/remind`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-cron-secret': cronSecret || '',
              },
            })

            if (remindRes.ok) {
              results.reminders_sent++
              console.log(`[invoice-overdue] Sent reminder for ${inv.invoice_number} (${daysOverdue}d overdue, reminder #${reminderCount + 1})`)
            } else {
              const errBody = await remindRes.text()
              results.errors.push(`Remind ${inv.invoice_number}: ${errBody}`)
            }
          } catch (err) {
            results.errors.push(`Remind ${inv.invoice_number}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    }

    console.log(`[invoice-overdue] Done: ${results.marked_overdue} marked overdue, ${results.reminders_sent} reminders sent`)

    return NextResponse.json({
      message: 'Invoice overdue check complete',
      ...results,
    })
  } catch (err) {
    console.error('[invoice-overdue] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
