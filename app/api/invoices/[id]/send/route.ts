/**
 * POST /api/invoices/[id]/send
 *
 * Admin "Send / Resend" for a TD invoice from the CRM dashboard.
 * Delegates to sendTDInvoice() which handles:
 *  - PDF generation
 *  - Audience resolution (portal vs no_portal via portal_tier)
 *  - Email build via buildInvoiceEmail (shared template, R092-compliant)
 *  - pay_token generation for no-portal recipients
 *  - Gmail send + payments.invoice_status → Sent update
 *  - QB sync (non-blocking)
 *
 * For Overdue resends: temporarily resets invoice_status to 'Draft'
 * so sendTDInvoice can run its normal flow (which sets it back to 'Sent').
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { sendTDInvoice } from '@/lib/invoice-auto-send'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Fetch payment to check status
  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select('id, invoice_status, sent_at, account_id, contact_id, invoice_number')
    .eq('id', id)
    .not('invoice_status', 'is', null)
    .single()

  if (!payment) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

  // Already sent — idempotent
  if (payment.invoice_status === 'Sent') {
    return NextResponse.json({ success: true, message: `Invoice already sent on ${payment.sent_at ?? 'an earlier date'}` })
  }

  const allowedStatuses = ['Draft', 'Overdue']
  if (!allowedStatuses.includes(payment.invoice_status ?? '')) {
    return NextResponse.json(
      { error: `Cannot send invoice with status "${payment.invoice_status}"` },
      { status: 400 },
    )
  }

  // Resolve recipient for the opts override. sendTDInvoice already does
  // account_contacts role='Owner' lookup as its fallback, but the admin
  // route may have a contact_id attached (One-Time / standalone contact
  // flows) that the fallback wouldn't find.
  let recipientEmail = ''
  let clientName = ''

  if (payment.contact_id) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('first_name, last_name, email, full_name')
      .eq('id', payment.contact_id)
      .single()
    if (contact?.email) recipientEmail = contact.email
    if (contact?.first_name) {
      clientName = `${contact.first_name} ${contact.last_name ?? ''}`.trim()
    } else if (contact?.full_name) {
      clientName = contact.full_name
    }
  } else if (payment.account_id) {
    const { data: link } = await supabaseAdmin
      .from('account_contacts')
      .select('contacts(first_name, last_name, email)')
      .eq('account_id', payment.account_id)
      .eq('role', 'Owner')
      .limit(1)
      .maybeSingle()
    const c = (link as unknown as { contacts: { first_name: string; last_name: string; email: string } } | null)?.contacts
    if (c?.email) recipientEmail = c.email
    if (c?.first_name) clientName = `${c.first_name} ${c.last_name ?? ''}`.trim()
  }

  if (!recipientEmail) {
    return NextResponse.json({ error: 'No contact email found for this invoice' }, { status: 400 })
  }

  try {
    // For Overdue resends, temporarily reset to Draft so sendTDInvoice
    // can proceed (it sets status back to Sent on success).
    if (payment.invoice_status === 'Overdue') {
      // eslint-disable-next-line no-restricted-syntax -- temporary resend status reset; tracked by dev_task 7ebb1e0c
      await supabaseAdmin
        .from('payments')
        .update({ invoice_status: 'Draft', updated_at: new Date().toISOString() })
        .eq('id', id)
    }

    await sendTDInvoice(id, {
      recipientEmail,
      clientName: clientName || undefined,
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    // If Overdue reset succeeded but send failed, restore Overdue status.
    if (payment.invoice_status === 'Overdue') {
      try {
        // eslint-disable-next-line no-restricted-syntax -- restore on failure; tracked by dev_task 7ebb1e0c
        await supabaseAdmin
          .from('payments')
          .update({ invoice_status: 'Overdue', updated_at: new Date().toISOString() })
          .eq('id', id)
      } catch {
        // Best-effort restore; log but don't mask the original error.
        console.error('[send-route] failed to restore Overdue status after send failure')
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
