import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { NextRequest, NextResponse } from 'next/server'
import { gmailPost } from '@/lib/gmail'
import { esc, fromHeader, headerSafe, isSafeRecipient, createRawEmail, recentlyEmailed } from '@/lib/portal/invoice-email'
import { validatePaymentLinkUrl } from '@/lib/portal/payment-link-rules'
import { invoiceStatusRule } from '@/lib/portal/invoice-status'
import { APP_BASE_URL } from '@/lib/config'

// One reminder per invoice per customer per 12 hours: enough for a genuine follow-up, too tight for spam.
const REMINDER_WINDOW_SECONDS = 12 * 60 * 60

/**
 * POST /api/portal/invoices/[id]/remind — Send payment reminder to customer
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const { data: invoice } = await supabaseAdmin
    .from('client_invoices')
    .select('*')
    .eq('id', id)
    .single()

  if (!invoice) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Access control — default-deny (contacts AND teammates; never skipped).
  if (!(await canAccessAccount(user, invoice.account_id, 'invoices_billing'))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // Only an invoice that still has something to collect (Sent, Overdue, Partial) can be reminded.
  if (!invoiceStatusRule(invoice.status)?.remindable) {
    return NextResponse.json({ error: 'A reminder can only be sent for an invoice that is still waiting for payment.' }, { status: 400 })
  }

  const { data: customer } = await supabaseAdmin
    .from('client_customers')
    .select('name, email')
    .eq('id', invoice.customer_id)
    .eq('account_id', invoice.account_id) // the customer must be this company's own
    .maybeSingle()

  if (!customer?.email) {
    return NextResponse.json({ error: 'Customer has no email' }, { status: 400 })
  }
  if (!isSafeRecipient(customer.email)) {
    return NextResponse.json({ error: 'The customer\'s email address is not valid. Please correct it and try again.' }, { status: 400 })
  }

  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('company_name')
    .eq('id', invoice.account_id)
    .single()

  const { data: defaultLink } = await supabaseAdmin
    .from('payment_links')
    .select('url')
    .eq('account_id', invoice.account_id)
    .eq('is_default', true)
    .order('created_at')
    .limit(1)
    .maybeSingle()

  const linkCheck = defaultLink?.url ? validatePaymentLinkUrl(defaultLink.url) : null
  const paymentLinkUrl = linkCheck && 'url' in linkCheck ? linkCheck.url : null
  const companyName = headerSafe(account?.company_name ?? 'Our Company')
  // What is STILL owed (a part-paid invoice must not ask for the full total again).
  const amountDue = Number(invoice.amount_due ?? (Number(invoice.total ?? 0) - Number(invoice.amount_paid ?? 0))) || 0
  const csym = invoice.currency === 'EUR' ? '\u20AC' : '$'
  const isOverdue = invoice.status === 'Overdue'

  const subject = isOverdue
    ? `Overdue: Invoice ${invoice.invoice_number} from ${companyName}`
    : `Reminder: Invoice ${invoice.invoice_number} from ${companyName}`

  // Reminder throttle (state = the email log; no new column needed).
  const subjects = [`Overdue: Invoice ${invoice.invoice_number} from ${companyName}`, `Reminder: Invoice ${invoice.invoice_number} from ${companyName}`]
  if (await recentlyEmailed(supabaseAdmin, { accountId: invoice.account_id, recipient: customer.email, subjects, windowSeconds: REMINDER_WINDOW_SECONDS })) {
    return NextResponse.json({ error: 'A reminder for this invoice was already sent to this customer in the last 12 hours.' }, { status: 429 })
  }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${isOverdue ? '#dc2626' : '#f59e0b'}; padding: 24px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 20px;">${isOverdue ? 'Payment Overdue' : 'Payment Reminder'}</h1>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
        <p>Dear ${esc(customer.name)},</p>
        <p>${isOverdue
          ? `This is a reminder that invoice <strong>${esc(invoice.invoice_number)}</strong> is now overdue.`
          : `This is a friendly reminder about invoice <strong>${esc(invoice.invoice_number)}</strong>.`
        }</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr style="background: #f8fafc;">
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Invoice</td>
            <td style="padding: 8px 12px; font-size: 14px;">${esc(invoice.invoice_number)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Amount Due</td>
            <td style="padding: 8px 12px; font-size: 18px; font-weight: bold; color: ${isOverdue ? '#dc2626' : '#f59e0b'};">${csym}${amountDue.toFixed(2)}</td>
          </tr>
          ${invoice.due_date ? `<tr style="background: #f8fafc;">
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Due Date</td>
            <td style="padding: 8px 12px; font-size: 14px; ${isOverdue ? 'color: #dc2626; font-weight: bold;' : ''}">${esc(invoice.due_date)}</td>
          </tr>` : ''}
        </table>
        ${invoice.message ? `<div style="background: #f8fafc; padding: 16px; border-radius: 8px;">
          <p style="margin: 0; font-size: 12px; color: #6b7280; text-transform: uppercase; font-weight: bold;">Payment Details</p>
          <p style="margin: 8px 0 0; font-size: 14px; white-space: pre-wrap;">${esc(invoice.message)}</p>
        </div>` : ''}
        ${paymentLinkUrl ? `<div style="text-align: center; margin-top: 20px;">
          <a href="${esc(paymentLinkUrl)}" style="display: inline-block; padding: 14px 32px; background: ${isOverdue ? '#dc2626' : '#f59e0b'}; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 15px;">
            Pay Now
          </a>
        </div>` : ''}

        <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">
          If you have already sent payment, please disregard this reminder. For questions, reply to this email.
        </p>
      </div>
    </div>
  `

  try {
    // The tracking row is the reminder log the throttle above reads, and it is written first so two quick clicks
    // cannot both pass. If the send fails it is removed again so a retry is not blocked.
    const trackingId = `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const { error: claimErr } = await supabaseAdmin.from('email_tracking').insert({
      tracking_id: trackingId,
      recipient: customer.email,
      subject,
      from_email: 'support@tonydurante.us',
      account_id: invoice.account_id || null,
      contact_id: invoice.contact_id || null,
    })
    const trackedHtml = html + `<img src="${APP_BASE_URL}/api/track/open/${trackingId}" width="1" height="1" style="display:none" alt="" />`

    try {
      const rawEmail = createRawEmail({
        from: fromHeader(companyName, 'support@tonydurante.us'),
        to: customer.email,
        subject,
        html: trackedHtml,
      })
      const sendResult = await gmailPost('/messages/send', { raw: rawEmail }) as { id?: string; threadId?: string }
      if (!claimErr) {
        await supabaseAdmin.from('email_tracking')
          .update({ gmail_message_id: sendResult?.id || null, gmail_thread_id: sendResult?.threadId || null })
          .eq('tracking_id', trackingId)
      }
    } catch (sendErr) {
      if (!claimErr) await supabaseAdmin.from('email_tracking').delete().eq('tracking_id', trackingId)
      throw sendErr
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Reminder email error:', err)
    return NextResponse.json({ error: 'Failed to send reminder' }, { status: 500 })
  }
}
