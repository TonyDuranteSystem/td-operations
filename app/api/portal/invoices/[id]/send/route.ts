import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'
import { gmailPost } from '@/lib/gmail'

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

  // Access control
  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(invoice.account_id)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  // Get customer email
  const { data: customer } = await supabaseAdmin
    .from('client_customers')
    .select('name, email')
    .eq('id', invoice.customer_id)
    .single()

  if (!customer?.email) {
    return NextResponse.json({ error: 'Customer has no email address' }, { status: 400 })
  }

  // Get account name for from line
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('company_name, bank_details, payment_link')
    .eq('id', invoice.account_id)
    .single()

  // Generate PDF inline (call own endpoint)
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000'

  // Instead of calling own endpoint, generate PDF directly
  // Import would be circular, so we build a simple email without PDF attachment first
  const csym = invoice.currency === 'EUR' ? '\u20AC' : '$'
  const companyName = account?.company_name ?? 'Our Company'

  // Build email
  const subject = `Invoice ${invoice.invoice_number} from ${companyName}`
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #2563eb; padding: 24px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 20px;">${companyName}</h1>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
        <p>Dear ${customer.name},</p>
        <p>Please find below the details for invoice <strong>${invoice.invoice_number}</strong>.</p>

        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr style="background: #f8fafc;">
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Invoice Number</td>
            <td style="padding: 8px 12px; font-size: 14px;">${invoice.invoice_number}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Issue Date</td>
            <td style="padding: 8px 12px; font-size: 14px;">${invoice.issue_date}</td>
          </tr>
          ${invoice.due_date ? `<tr style="background: #f8fafc;">
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Due Date</td>
            <td style="padding: 8px 12px; font-size: 14px;">${invoice.due_date}</td>
          </tr>` : ''}
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Total Amount</td>
            <td style="padding: 8px 12px; font-size: 18px; font-weight: bold; color: #2563eb;">${csym}${invoice.total.toFixed(2)}</td>
          </tr>
        </table>

        ${invoice.message ? `<div style="background: #f8fafc; padding: 16px; border-radius: 8px; margin-top: 16px;">
          <p style="margin: 0; font-size: 12px; color: #6b7280; text-transform: uppercase; font-weight: bold;">Payment Terms</p>
          <p style="margin: 8px 0 0; font-size: 14px; white-space: pre-wrap;">${invoice.message}</p>
        </div>` : ''}

        ${(() => {
          const bd = account?.bank_details as Record<string, string> | null
          if (!bd || !Object.values(bd).some(v => v)) return ''
          const fields = [
            bd.account_holder && `Account Holder: ${bd.account_holder}`,
            bd.bank_name && `Bank: ${bd.bank_name}`,
            bd.iban && `IBAN: ${bd.iban}`,
            bd.swift_bic && `SWIFT/BIC: ${bd.swift_bic}`,
            bd.account_number && `Account: ${bd.account_number}`,
            bd.routing_number && `Routing: ${bd.routing_number}`,
            bd.notes && bd.notes,
          ].filter(Boolean).join('<br/>')
          return `<div style="background: #f0fdf4; padding: 16px; border-radius: 8px; margin-top: 16px; border: 1px solid #bbf7d0;">
            <p style="margin: 0; font-size: 12px; color: #15803d; text-transform: uppercase; font-weight: bold;">Bank Details</p>
            <p style="margin: 8px 0 0; font-size: 13px; color: #166534;">${fields}</p>
          </div>`
        })()}

        ${account?.payment_link ? `<div style="text-align: center; margin-top: 20px;">
          <a href="${account.payment_link}" style="display: inline-block; padding: 14px 32px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 15px;">
            Pay Now
          </a>
        </div>` : ''}

        <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">
          If you have any questions, please reply to this email.
        </p>
      </div>
    </div>
  `

  try {
    // Generate PDF for attachment
    let pdfBase64: string | null = null
    try {
      const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'
      const pdfRes = await fetch(`${baseUrl}/api/portal/invoices/${id}/pdf`, {
        headers: { Cookie: request.headers.get('cookie') || '' },
      })
      if (pdfRes.ok) {
        const pdfBuffer = await pdfRes.arrayBuffer()
        pdfBase64 = Buffer.from(pdfBuffer).toString('base64')
      }
    } catch {
      // PDF generation failed — send without attachment
    }

    // Send via Gmail (as the support account)
    const rawEmail = createRawEmail({
      from: `${companyName} <support@tonydurante.us>`,
      to: customer.email,
      subject,
      html,
      attachment: pdfBase64 ? { base64: pdfBase64, filename: `${invoice.invoice_number}.pdf` } : undefined,
    })

    await gmailPost('/messages/send', { raw: rawEmail })

    // Update invoice status to Sent
    await supabaseAdmin
      .from('client_invoices')
      .update({ status: 'Sent', updated_at: new Date().toISOString() })
      .eq('id', id)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Failed to send invoice email:', err)
    return NextResponse.json({ error: 'Failed to send email' }, { status: 500 })
  }
}

function createRawEmail({ from, to, subject, html, attachment }: {
  from: string; to: string; subject: string; html: string
  attachment?: { base64: string; filename: string }
}): string {
  const boundary = `boundary_${Date.now()}`
  const contentType = attachment
    ? `multipart/mixed; boundary="${boundary}"`
    : `multipart/alternative; boundary="${boundary}"`

  const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
  const parts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${contentType}`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html).toString('base64'),
  ]

  if (attachment) {
    parts.push(
      `--${boundary}`,
      `Content-Type: application/pdf; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      attachment.base64,
    )
  }

  parts.push(`--${boundary}--`)

  return Buffer.from(parts.join('\r\n')).toString('base64url')
}
