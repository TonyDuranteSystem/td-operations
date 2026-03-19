import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'
import { gmailPost } from '@/lib/gmail'

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

  // Access control
  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(invoice.account_id)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  // Only remind on Sent or Overdue
  if (invoice.status !== 'Sent' && invoice.status !== 'Overdue') {
    return NextResponse.json({ error: 'Can only remind on Sent or Overdue invoices' }, { status: 400 })
  }

  const { data: customer } = await supabaseAdmin
    .from('client_customers')
    .select('name, email')
    .eq('id', invoice.customer_id)
    .single()

  if (!customer?.email) {
    return NextResponse.json({ error: 'Customer has no email' }, { status: 400 })
  }

  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('company_name, bank_details, payment_link')
    .eq('id', invoice.account_id)
    .single()

  const companyName = account?.company_name ?? 'Our Company'
  const csym = invoice.currency === 'EUR' ? '\u20AC' : '$'
  const isOverdue = invoice.status === 'Overdue'

  const subject = isOverdue
    ? `Overdue: Invoice ${invoice.invoice_number} from ${companyName}`
    : `Reminder: Invoice ${invoice.invoice_number} from ${companyName}`

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${isOverdue ? '#dc2626' : '#f59e0b'}; padding: 24px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 20px;">${isOverdue ? 'Payment Overdue' : 'Payment Reminder'}</h1>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
        <p>Dear ${customer.name},</p>
        <p>${isOverdue
          ? `This is a reminder that invoice <strong>${invoice.invoice_number}</strong> is now overdue.`
          : `This is a friendly reminder about invoice <strong>${invoice.invoice_number}</strong>.`
        }</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr style="background: #f8fafc;">
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Invoice</td>
            <td style="padding: 8px 12px; font-size: 14px;">${invoice.invoice_number}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Amount Due</td>
            <td style="padding: 8px 12px; font-size: 18px; font-weight: bold; color: ${isOverdue ? '#dc2626' : '#f59e0b'};">${csym}${invoice.total.toFixed(2)}</td>
          </tr>
          ${invoice.due_date ? `<tr style="background: #f8fafc;">
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Due Date</td>
            <td style="padding: 8px 12px; font-size: 14px; ${isOverdue ? 'color: #dc2626; font-weight: bold;' : ''}">${invoice.due_date}</td>
          </tr>` : ''}
        </table>
        ${invoice.message ? `<div style="background: #f8fafc; padding: 16px; border-radius: 8px;">
          <p style="margin: 0; font-size: 12px; color: #6b7280; text-transform: uppercase; font-weight: bold;">Payment Details</p>
          <p style="margin: 8px 0 0; font-size: 14px; white-space: pre-wrap;">${invoice.message}</p>
        </div>` : ''}
        ${account?.payment_link ? `<div style="text-align: center; margin-top: 20px;">
          <a href="${account.payment_link}" style="display: inline-block; padding: 14px 32px; background: ${isOverdue ? '#dc2626' : '#f59e0b'}; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 15px;">
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
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
    const boundary = `boundary_${Date.now()}`
    const rawEmail = [
      `From: ${companyName} <support@tonydurante.us>`,
      `To: ${customer.email}`,
      `Subject: ${encodedSubject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html).toString('base64'),
      `--${boundary}--`,
    ].join('\r\n')

    await gmailPost('/messages/send', { raw: Buffer.from(rawEmail).toString('base64url') })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Reminder email error:', err)
    return NextResponse.json({ error: 'Failed to send reminder' }, { status: 500 })
  }
}
