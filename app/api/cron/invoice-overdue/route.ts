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
import { syncInvoiceStatus } from '@/lib/portal/unified-invoice'
import { logCron } from '@/lib/cron-log'

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  try {
    // Verify cron secret
    const authHeader = req.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const today = new Date().toISOString().split('T')[0]
    const results = { marked_overdue: 0, reminders_sent: 0, errors: [] as string[] }

    // 1. Mark Sent/Partial invoices as Overdue when due_date < today
    // Uses syncInvoiceStatus for bidirectional sync (updates BOTH payments + client_invoices)
    // Skip accounts with dunning_pause = true
    const { data: pausedAccounts } = await supabaseAdmin
      .from('accounts')
      .select('id')
      .eq('dunning_pause', true)
    const pausedIds = (pausedAccounts ?? []).map(a => a.id)

    // Query payments that need to become Overdue (read, not update)
    let candidateQuery = supabaseAdmin
      .from('payments')
      .select('id, invoice_number, account_id')
      .in('invoice_status', ['Sent', 'Partial'])
      .lt('due_date', today)

    if (pausedIds.length > 0) {
      candidateQuery = candidateQuery.not('account_id', 'in', `(${pausedIds.join(',')})`)
    }

    const { data: candidates, error: queryErr } = await candidateQuery

    if (queryErr) {
      console.error('[invoice-overdue] Query error:', queryErr.message)
      results.errors.push(`Query overdue candidates: ${queryErr.message}`)
    } else if (candidates && candidates.length > 0) {
      // Use syncInvoiceStatus for each — updates BOTH tables
      for (const inv of candidates) {
        try {
          await syncInvoiceStatus('payment', inv.id, 'Overdue')
          results.marked_overdue++
        } catch (err) {
          results.errors.push(`Mark overdue ${inv.invoice_number}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (results.marked_overdue > 0) {
        console.warn(`[invoice-overdue] Marked ${results.marked_overdue} invoices as Overdue:`,
          candidates.map(i => i.invoice_number).join(', '))
      }
    }

    // 2. Auto-send reminders for overdue invoices
    // Uses per-account dunning config (dunning_reminder_1_days, dunning_reminder_2_days)
    // Defaults: 7 days for 1st reminder, 14 days for 2nd

    // Fetch dunning config for all accounts
    const { data: accountConfigs } = await supabaseAdmin
      .from('accounts')
      .select('id, dunning_reminder_1_days, dunning_reminder_2_days, dunning_escalation_email, dunning_pause')

    const dunningMap: Record<string, { r1: number; r2: number; escalation: string | null; paused: boolean }> = {}
    for (const ac of (accountConfigs ?? [])) {
      dunningMap[ac.id] = {
        r1: ac.dunning_reminder_1_days ?? 7,
        r2: ac.dunning_reminder_2_days ?? 14,
        escalation: ac.dunning_escalation_email ?? null,
        paused: ac.dunning_pause ?? false,
      }
    }

    const { data: overdueInvoices } = await supabaseAdmin
      .from('payments')
      .select('id, invoice_number, due_date, reminder_count, account_id, amount, currency')
      .eq('invoice_status', 'Overdue')
      .order('due_date', { ascending: true })

    if (overdueInvoices) {
      for (const inv of overdueInvoices) {
        // Check if account has dunning paused
        const config = inv.account_id ? dunningMap[inv.account_id] : null
        if (config?.paused) continue

        const reminder1Days = config?.r1 ?? 7
        const reminder2Days = config?.r2 ?? 14

        const dueDate = new Date(inv.due_date + 'T00:00:00')
        const daysOverdue = Math.floor((Date.now() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
        const reminderCount = inv.reminder_count ?? 0

        let shouldRemind = false
        if (daysOverdue >= reminder2Days && reminderCount < 2) shouldRemind = true
        else if (daysOverdue >= reminder1Days && reminderCount < 1) shouldRemind = true

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
              console.warn(`[invoice-overdue] Sent reminder for ${inv.invoice_number} (${daysOverdue}d overdue, reminder #${reminderCount + 1}, config: r1=${reminder1Days}d r2=${reminder2Days}d)`)
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

    console.warn(`[invoice-overdue] Done: ${results.marked_overdue} marked overdue, ${results.reminders_sent} reminders sent`)

    logCron({ endpoint: '/api/cron/invoice-overdue', status: 'success', duration_ms: Date.now() - startTime, details: results })

    return NextResponse.json({
      message: 'Invoice overdue check complete',
      ...results,
    })
  } catch (err) {
    console.error('[invoice-overdue] Error:', err)
    logCron({ endpoint: '/api/cron/invoice-overdue', status: 'error', duration_ms: Date.now() - startTime, error_message: err instanceof Error ? err.message : String(err) })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
