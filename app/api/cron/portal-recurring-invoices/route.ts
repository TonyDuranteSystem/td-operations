export const dynamic = 'force-dynamic'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { createUnifiedInvoice } from '@/lib/portal/unified-invoice'
import { createPortalNotification } from '@/lib/portal/notifications'
import { NextResponse } from 'next/server'
import { logCron } from '@/lib/cron-log'
import { getOfficeDateString } from '@/lib/portal/office-hours'
import { nextRecurringDate, daysBetween, addDaysYmd, type RecurringFrequency } from '@/lib/portal/recurring-date'

/**
 * GET /api/cron/portal-recurring-invoices
 *
 * Daily job for the CLIENT'S OWN recurring sales invoices (not Tony Durante's billing: that is
 * /api/cron/recurring-invoices and writes `payments`).
 *
 * A recurring invoice is a normal invoice with `recurring_frequency` and a `recurring_next_date`. Once the client has
 * SENT it (status Sent or Paid), every period this job prepares a new DRAFT copy dated on the cycle day. It is never
 * emailed automatically: the client reviews and sends each copy. Voiding the original stops the schedule.
 *
 * Safety (dev job 1a23f5f1, council review 2026-10-09):
 *  - Fail-closed CRON_SECRET: anyone could trigger this before.
 *  - One copy per template per run, keyed `recurring:<template>:<cycle date>` so a retry, a double run or a failed
 *    "advance the date" step can never create the same cycle twice.
 *  - The date advance is checked (compare-and-swap on the cycle date) and month-end safe.
 *  - Failures are logged as an error, never reported as success.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const today = getOfficeDateString()

  const { data: recurring, error: listErr } = await supabaseAdmin
    .from('client_invoices')
    .select('*, client_invoice_items(*)')
    .not('recurring_frequency', 'is', null)
    .not('recurring_next_date', 'is', null)
    .lte('recurring_next_date', today)
    .or(`recurring_end_date.is.null,recurring_end_date.gte.${today}`)
    // Only a schedule the client has actually SENT runs. Overdue and Partial are still sent invoices: an unpaid
    // original must not silently stop the schedule.
    .in('status', ['Sent', 'Overdue', 'Partial', 'Paid'])
    .limit(200)

  if (listErr) {
    logCron({ endpoint: '/api/cron/portal-recurring-invoices', status: 'error', duration_ms: Date.now() - startTime, error_message: listErr.message })
    return NextResponse.json({ error: 'Could not list recurring invoices' }, { status: 500 })
  }
  if (!recurring || recurring.length === 0) {
    return NextResponse.json({ generated: 0 })
  }

  let generated = 0
  const failures: Array<{ template: string; reason: string }> = []

  for (const template of recurring) {
    const cycleDate = template.recurring_next_date as string
    try {
      const frequency = template.recurring_frequency as RecurringFrequency
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items = (template.client_invoice_items as any[]) ?? []
      if (items.length === 0) throw new Error('the invoice has no lines to copy')

      // Same gap between issue and due date as the original, counted from the cycle day.
      let dueDate: string | undefined
      if (template.due_date && template.issue_date) {
        const gap = daysBetween(template.issue_date, template.due_date)
        const due = gap !== null ? addDaysYmd(cycleDate, gap) : null
        if (due) dueDate = due
      }

      // A cycle that is more than a week late (the original was sent long after it was written, or the job was down)
      // is dated today instead of the past, and the cycles in between are skipped rather than replayed one per day.
      const lateBy = daysBetween(cycleDate, today) ?? 0
      const issueOn = lateBy > 7 ? today : cycleDate
      if (lateBy > 7 && dueDate) {
        const gap = daysBetween(template.issue_date, template.due_date)
        const due = gap !== null ? addDaysYmd(issueOn, gap) : null
        if (due) dueDate = due
      }

      await createUnifiedInvoice({
        account_id: template.account_id || undefined,
        contact_id: template.contact_id || undefined,
        customer_id: template.customer_id || undefined,
        line_items: items.map((item: { description: string; quantity: number; unit_price: number; tax_rate: number | null }) => ({
          description: item.description,
          unit_price: item.unit_price,
          quantity: item.quantity,
          tax_rate: item.tax_rate ?? undefined,
        })),
        currency: (template.currency || 'USD') as 'USD' | 'EUR',
        discount: Number(template.discount) || 0,
        bank_account_id: template.bank_account_id || null,
        issue_date: issueOn,
        due_date: dueDate,
        notes: template.notes || undefined,
        message: template.message || undefined,
        recurring_parent_id: template.id,
        idempotency_key: `recurring:${template.id}:${cycleDate}`,
      })

      // Advance the schedule. Anchored on the ORIGINAL issue day so Jan 31 monthly goes Feb 28, Mar 31 (no drift).
      const anchor = template.issue_date ? Number(String(template.issue_date).slice(8, 10)) : undefined
      let next = nextRecurringDate(cycleDate, frequency, anchor)
      if (!next) throw new Error('could not work out the next date')
      // Jump past the cycles that are already behind us (bounded, so a bad date can never loop forever).
      for (let guard = 0; guard < 120 && next && next <= today; guard++) next = nextRecurringDate(next, frequency, anchor)
      if (!next) throw new Error('could not work out the next date')
      if (template.recurring_end_date && next > template.recurring_end_date) next = null as unknown as string

      const { data: advanced, error: advErr } = await supabaseAdmin
        .from('client_invoices')
        .update({ recurring_next_date: next })
        .eq('id', template.id)
        .eq('recurring_next_date', cycleDate)
        .select('id')
      if (advErr) throw new Error(`the copy was made but the next date could not be saved: ${advErr.message}`)
      if (!advanced || advanced.length === 0) {
        // Another run already advanced it: the idempotency key made sure no duplicate invoice exists.
        continue
      }

      await createPortalNotification({
        account_id: template.account_id,
        type: 'invoice',
        title: `Recurring invoice ready: ${template.invoice_number}`,
        body: 'A new draft was prepared from your recurring invoice. Review it and send it.',
        link: '/portal/invoices',
      })

      generated++
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`Recurring invoice failed for ${template.id}:`, reason)
      failures.push({ template: template.id, reason })
    }
  }

  logCron({
    endpoint: '/api/cron/portal-recurring-invoices',
    status: failures.length > 0 ? 'error' : 'success',
    duration_ms: Date.now() - startTime,
    error_message: failures.length > 0 ? `${failures.length} recurring invoice(s) failed` : undefined,
    details: { generated, checked: recurring.length, failures },
  })

  return NextResponse.json({ generated, checked: recurring.length, failed: failures.length })
}
