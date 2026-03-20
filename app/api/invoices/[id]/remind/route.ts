import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { gmailPost } from '@/lib/gmail'
import { safeSend } from '@/lib/mcp/safe-send'

/**
 * POST /api/invoices/[id]/remind — Send payment reminder for TD LLC invoice (dashboard auth)
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select('*')
    .eq('id', id)
    .not('invoice_status', 'is', null)
    .single()

  if (!payment) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

  // Only remind on Sent or Overdue
  if (!['Sent', 'Overdue'].includes(payment.invoice_status)) {
    return NextResponse.json(
      { error: `Cannot remind on invoice with status "${payment.invoice_status}"` },
      { status: 400 }
    )
  }

  // Get contact email
  const { data: contactLink } = await supabaseAdmin
    .from('account_contacts')
    .select('contacts(first_name, last_name, email)')
    .eq('account_id', payment.account_id)
    .eq('role', 'Owner')
    .limit(1)
    .maybeSingle()

  const contact = (contactLink as unknown as { contacts: { first_name: string; last_name: string; email: string } })?.contacts

  if (!contact?.email) {
    return NextResponse.json({ error: 'No contact email found' }, { status: 400 })
  }

  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('company_name')
    .eq('id', payment.account_id)
    .single()

  const clientName = contact.first_name
    ? `${contact.first_name} ${contact.last_name ?? ''}`.trim()
    : account?.company_name ?? 'Client'
  const invoiceNumber = payment.invoice_number ?? 'DRAFT'
  const isOverdue = payment.invoice_status === 'Overdue'
  const csym = (payment.amount_currency ?? 'USD') === 'EUR' ? '\u20AC' : '$'
  const total = Number(payment.total ?? payment.amount ?? 0)
  const reminderCount = Number(payment.reminder_count ?? 0)

  const result = await safeSend({
    sendFn: async () => {
      const subject = isOverdue
        ? `Overdue: Invoice ${invoiceNumber} — Tony Durante LLC`
        : `Reminder: Invoice ${invoiceNumber} — Tony Durante LLC`

      const accentColor = isOverdue ? '#dc2626' : '#f59e0b'

      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background: ${accentColor}; padding: 24px; border-radius: 12px 12px 0 0;">
            <h1 style="color: white; margin: 0; font-size: 20px;">${isOverdue ? 'Payment Overdue' : 'Payment Reminder'}</h1>
          </div>
          <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
            <p>Dear ${clientName},</p>
            <p>${isOverdue
              ? `This is a reminder that invoice <strong>${invoiceNumber}</strong> is now past due.`
              : `This is a friendly reminder regarding invoice <strong>${invoiceNumber}</strong>.`
            }</p>

            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
              <tr style="background: #f8fafc;">
                <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Invoice</td>
                <td style="padding: 8px 12px; font-size: 14px;">${invoiceNumber}</td>
              </tr>
              <tr>
                <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Amount Due</td>
                <td style="padding: 8px 12px; font-size: 18px; font-weight: bold; color: ${accentColor};">${csym}${total.toFixed(2)}</td>
              </tr>
              ${payment.due_date ? `<tr style="background: #f8fafc;">
                <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Due Date</td>
                <td style="padding: 8px 12px; font-size: 14px; ${isOverdue ? 'color: #dc2626; font-weight: bold;' : ''}">${payment.due_date}</td>
              </tr>` : ''}
            </table>

            <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">
              If you have already sent payment, please disregard this reminder. For questions, reply directly to this email.
            </p>

            <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; font-size: 11px; color: #9ca3af;">
              Tony Durante LLC · 1111 Lincoln Road, Suite 400, Miami Beach, FL 33139
            </div>
          </div>
        </div>
      `

      const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
      const boundary = `boundary_${Date.now()}`
      const rawEmail = [
        'From: Tony Durante LLC <support@tonydurante.us>',
        `To: ${contact.email}`,
        `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(html).toString('base64'),
        `--${boundary}--`,
      ].join('\r\n')

      return gmailPost('/messages/send', {
        raw: Buffer.from(rawEmail).toString('base64url'),
      })
    },

    postSendSteps: [
      {
        name: 'update_reminder_count',
        fn: async () => {
          await supabaseAdmin
            .from('payments')
            .update({
              reminder_count: reminderCount + 1,
              last_reminder_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', id)
        },
      },
    ],
  })

  if (result.alreadySent) {
    return NextResponse.json({ success: true, message: result.idempotencyMessage })
  }

  return NextResponse.json({
    success: true,
    reminderNumber: reminderCount + 1,
    ...(result.hasWarnings ? { warning: 'Reminder sent but DB update failed', steps: result.steps } : {}),
  })
}
