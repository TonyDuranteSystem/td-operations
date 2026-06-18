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
 * For Sent/Overdue/Partial resends: temporarily resets invoice_status to
 * 'Draft' so sendTDInvoice can run its normal flow (which sets it to 'Sent').
 * Partial invoices are restored to 'Partial' after a successful send so the
 * partially-paid indicator survives the resend.
 */

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { sendTDInvoice } from '@/lib/invoice-auto-send'
import { resolvePaymentRecipient } from '@/lib/portal/resolve-payment-recipient'

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

  // Capture the original status — the resend flow temporarily flips it to
  // 'Draft' below, so we restore from this on failure (and for Partial, on
  // success too).
  const originalStatus = payment.invoice_status ?? ''

  const allowedStatuses = ['Draft', 'Sent', 'Overdue', 'Partial']
  if (!allowedStatuses.includes(originalStatus)) {
    return NextResponse.json(
      { error: `Cannot send invoice with status "${originalStatus}"` },
      { status: 400 },
    )
  }

  // Resolve recipient via the single shared resolver (contact_id → owner-role
  // contact, case-insensitive → any linked contact → account communication
  // email). NEVER hand-roll an exact-case role='Owner' lookup here — it
  // silently resolves zero rows for lowercase "owner" links and breaks resend
  // (the ADWise incident, 2026-06-18).
  const recipient = await resolvePaymentRecipient(payment, supabaseAdmin)

  if (!recipient) {
    return NextResponse.json({ error: 'No contact email found for this invoice' }, { status: 400 })
  }

  const recipientEmail = recipient.email
  const clientName = recipient.name

  try {
    // For Sent/Overdue/Partial resends, temporarily reset to Draft so
    // sendTDInvoice can proceed (it sets status to Sent on success).
    if (originalStatus === 'Overdue' || originalStatus === 'Sent' || originalStatus === 'Partial') {
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

    // sendTDInvoice always ends at 'Sent'. A Partial invoice (already partially
    // paid) must keep its Partial status so the partially-paid indicator and
    // amount-due math survive the resend.
    if (originalStatus === 'Partial') {
      // eslint-disable-next-line no-restricted-syntax -- restore partial status after resend; tracked by dev_task 7ebb1e0c
      await supabaseAdmin
        .from('payments')
        .update({ invoice_status: 'Partial', updated_at: new Date().toISOString() })
        .eq('id', id)
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    // If the temp reset succeeded but send failed, restore the original status.
    if (originalStatus === 'Overdue' || originalStatus === 'Sent' || originalStatus === 'Partial') {
      try {
        // eslint-disable-next-line no-restricted-syntax -- restore on failure; tracked by dev_task 7ebb1e0c
        await supabaseAdmin
          .from('payments')
          .update({ invoice_status: originalStatus, updated_at: new Date().toISOString() })
          .eq('id', id)
      } catch {
        // Best-effort restore; log but don't mask the original error.
        console.error('[send-route] failed to restore status after send failure')
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
