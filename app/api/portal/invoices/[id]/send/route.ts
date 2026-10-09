import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { NextRequest, NextResponse } from 'next/server'
import { gmailPost } from '@/lib/gmail'
import { APP_BASE_URL } from '@/lib/config'
import { getCompanyEmail } from '@/lib/portal/queries'
import { pdfStatusForSend } from '@/lib/portal/invoice-status'
import { renderInvoicePdf } from '@/lib/portal/invoice-pdf'
import { esc, fromHeader, headerSafe, isSafeRecipient, createRawEmail, recentlyEmailed, overDailyEmailCap } from '@/lib/portal/invoice-email'
import { getInvoicePaymentLinkUrl } from '@/lib/portal/payment-link-lookup'

/**
 * POST /api/portal/invoices/[id]/send — Send invoice via email to customer
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Fetch invoice
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

  // A voided or split invoice must never be emailed. Re-sending a Sent / Overdue / Partial / Paid one (as a
  // record, or because the customer lost it) stays allowed and leaves its status alone.
  if (invoice.status === 'Cancelled' || invoice.status === 'Split') {
    return NextResponse.json({ error: `A ${invoice.status === 'Cancelled' ? 'voided' : 'split'} invoice cannot be sent.` }, { status: 400 })
  }

  // Get customer email
  const { data: customer } = await supabaseAdmin
    .from('client_customers')
    .select('name, email')
    .eq('id', invoice.customer_id)
    .eq('account_id', invoice.account_id) // the customer must be this company's own
    .maybeSingle()

  if (!customer?.email) {
    return NextResponse.json({ error: 'Customer has no email address' }, { status: 400 })
  }
  if (!isSafeRecipient(customer.email)) {
    return NextResponse.json({ error: 'The customer\'s email address is not valid. Please correct it and try again.' }, { status: 400 })
  }

  // Get account name and reply-to email
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('company_name')
    .eq('id', invoice.account_id)
    .single()

  const replyTo = invoice.account_id ? await getCompanyEmail(invoice.account_id) : null

  // Get bank account — use invoice's selected account, fallback to default
  let bankAccount = null
  if (invoice.bank_account_id) {
    const { data } = await supabaseAdmin
      .from('client_bank_accounts')
      .select('*')
      .eq('id', invoice.bank_account_id)
      .eq('account_id', invoice.account_id) // never another company's bank details
      .maybeSingle()
    bankAccount = data
  }
  if (!bankAccount) {
    const { data } = await supabaseAdmin
      .from('client_bank_accounts')
      .select('*')
      .eq('account_id', invoice.account_id)
      .eq('show_on_invoice', true)
      .order('created_at')
      .limit(1)
      .maybeSingle()
    bankAccount = data
  }

  // The company's default payment link (or its oldest, if none is marked), plain https only.
  const paymentLinkUrl = await getInvoicePaymentLinkUrl(invoice.account_id)

  const csym = invoice.currency === 'EUR' ? '\u20AC' : '$'
  const companyName = headerSafe(account?.company_name ?? 'Our Company')

  // Build email
  const subject = `Invoice ${invoice.invoice_number} from ${companyName}`
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #2563eb; padding: 24px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 20px;">${esc(companyName)}</h1>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
        <p>Dear ${esc(customer.name)},</p>
        <p>Please find below the details for invoice <strong>${esc(invoice.invoice_number)}</strong>.</p>

        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr style="background: #f8fafc;">
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Invoice Number</td>
            <td style="padding: 8px 12px; font-size: 14px;">${esc(invoice.invoice_number)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Issue Date</td>
            <td style="padding: 8px 12px; font-size: 14px;">${esc(invoice.issue_date)}</td>
          </tr>
          ${invoice.due_date ? `<tr style="background: #f8fafc;">
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Due Date</td>
            <td style="padding: 8px 12px; font-size: 14px;">${esc(invoice.due_date)}</td>
          </tr>` : ''}
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Total Amount</td>
            <td style="padding: 8px 12px; font-size: 18px; font-weight: bold; color: #2563eb;">${csym}${(invoice.total ?? 0).toFixed(2)}</td>
          </tr>
        </table>

        ${invoice.message ? `<div style="background: #f8fafc; padding: 16px; border-radius: 8px; margin-top: 16px;">
          <p style="margin: 0; font-size: 12px; color: #6b7280; text-transform: uppercase; font-weight: bold;">Payment Terms</p>
          <p style="margin: 8px 0 0; font-size: 14px; white-space: pre-wrap;">${esc(invoice.message)}</p>
        </div>` : ''}

        ${(() => {
          if (!bankAccount) return ''
          // Each field is escaped on its own, THEN joined with <br/> (escaping the joined text would break the line breaks).
          const fields = [
            bankAccount.account_holder && `Account Holder: ${esc(bankAccount.account_holder)}`,
            bankAccount.bank_name && `Bank: ${esc(bankAccount.bank_name)}`,
            bankAccount.iban && `IBAN: ${esc(bankAccount.iban)}`,
            bankAccount.swift_bic && `SWIFT/BIC: ${esc(bankAccount.swift_bic)}`,
            bankAccount.account_number && `Account: ${esc(bankAccount.account_number)}`,
            bankAccount.routing_number && `Routing: ${esc(bankAccount.routing_number)}`,
            bankAccount.notes && esc(bankAccount.notes),
          ].filter(Boolean).join('<br/>')
          return `<div style="background: #f0fdf4; padding: 16px; border-radius: 8px; margin-top: 16px; border: 1px solid #bbf7d0;">
            <p style="margin: 0; font-size: 12px; color: #15803d; text-transform: uppercase; font-weight: bold;">Bank Details — ${esc(bankAccount.label)}</p>
            <p style="margin: 8px 0 0; font-size: 13px; color: #166534;">${fields}</p>
          </div>`
        })()}

        ${paymentLinkUrl ? `<div style="text-align: center; margin-top: 20px;">
          <a href="${esc(paymentLinkUrl)}" style="display: inline-block; padding: 14px 32px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 15px;">
            Pay Now
          </a>
        </div>` : ''}

        <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">
          If you have any questions, please reply to this email.
        </p>
      </div>
    </div>
  `

  if (await overDailyEmailCap(supabaseAdmin, invoice.account_id)) {
    return NextResponse.json({ error: 'This company has reached today\'s limit of invoice emails. Please try again tomorrow.' }, { status: 429 })
  }

  // Double-click / second-tab guard: the same invoice to the same person within a minute is a duplicate. The claim
  // row below is written BEFORE the email goes out, so the window is milliseconds, not the whole PDF + Gmail round trip.
  if (await recentlyEmailed(supabaseAdmin, { accountId: invoice.account_id, recipient: customer.email, subjects: [subject], windowSeconds: 60 })) {
    return NextResponse.json({ error: 'This invoice was just sent to this customer. Please wait a minute before sending it again.' }, { status: 409 })
  }

  let claimedTrackingId: string | null = null
  try {
    // Generate tracking ID and inject pixel into HTML
    const trackingId = `et_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const pixelUrl = `${APP_BASE_URL}/api/track/open/${trackingId}`
    const trackedHtml = html + `<img src="${pixelUrl}" width="1" height="1" style="display:none" alt="" />`

    // Build the PDF as it will look once sent, so the customer never receives a DRAFT-stamped file.
    // Built in-process (no HTTP call back to ourselves). If it cannot be built we stop: an invoice
    // email without its PDF would be reported as sent when it is not what the client meant to send.
    // Claim the send now (the row doubles as the email tracking record). If the send fails it is removed again,
    // so a failed attempt never blocks the retry.
    const { error: claimErr } = await supabaseAdmin.from('email_tracking').insert({
      tracking_id: trackingId,
      recipient: customer.email,
      subject,
      from_email: 'support@tonydurante.us',
      account_id: invoice.account_id || null,
      contact_id: invoice.contact_id || null,
    })
    if (!claimErr) claimedTrackingId = trackingId

    let pdfBase64: string
    try {
      const pdfBytes = await renderInvoicePdf({ invoice, shownStatus: pdfStatusForSend(invoice.status) })
      pdfBase64 = Buffer.from(pdfBytes).toString('base64')
    } catch (pdfErr) {
      if (claimedTrackingId) await supabaseAdmin.from('email_tracking').delete().eq('tracking_id', claimedTrackingId)
      console.error('Invoice PDF could not be built; nothing was sent:', pdfErr)
      return NextResponse.json(
        { error: 'The invoice PDF could not be prepared, so nothing was sent. Please try again.' },
        { status: 502 },
      )
    }

    const rawEmail = createRawEmail({
      from: fromHeader(companyName, 'support@tonydurante.us'),
      to: customer.email,
      subject,
      html: trackedHtml,
      replyTo: replyTo ?? undefined,
      attachment: { base64: pdfBase64, filename: `${invoice.invoice_number}.pdf` },
    })

    const sendResult = await gmailPost('/messages/send', { raw: rawEmail }) as { id?: string; threadId?: string }

    // Complete the tracking record (the claim row written above) with the Gmail ids.
    if (claimedTrackingId) {
      await supabaseAdmin.from('email_tracking')
        .update({ gmail_message_id: sendResult?.id || null, gmail_thread_id: sendResult?.threadId || null })
        .eq('tracking_id', claimedTrackingId)
    }

    // Standard invoice lifecycle: sending only advances a Draft → Sent. It must
    // NEVER downgrade an already Sent / Overdue / Paid invoice — re-sending a
    // paid invoice (e.g. as a record) leaves its status untouched.
    let statusUpdated = true
    if (invoice.status === 'Draft') {
      // Only flips if it is still a Draft (two quick clicks cannot both write), and the result is
      // checked: a failed update used to leave the invoice Draft after the email had gone out.
      const { error: flipErr } = await supabaseAdmin
        .from('client_invoices')
        .update({ status: 'Sent', updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('status', 'Draft')
      if (flipErr) {
        console.error('Invoice email sent but status update failed:', flipErr)
        statusUpdated = false
      }
      // If someone else already moved it out of Draft, the guard above simply matches nothing.
    }

    // The email is out. If the status could not be saved say so, so the client does not send it again.
    return NextResponse.json({ success: true, statusUpdated })
  } catch (err) {
    if (claimedTrackingId) await supabaseAdmin.from('email_tracking').delete().eq('tracking_id', claimedTrackingId)
    console.error('Failed to send invoice email:', err)
    return NextResponse.json({ error: 'Failed to send email' }, { status: 500 })
  }
}
