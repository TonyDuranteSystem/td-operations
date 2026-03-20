import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NextRequest, NextResponse } from 'next/server'
import { gmailPost } from '@/lib/gmail'
import { generateInvoicePdf, type InvoicePdfInput } from '@/lib/pdf/invoice-pdf'
import { safeSend } from '@/lib/mcp/safe-send'
import { syncInvoiceToQB } from '@/lib/qb-sync'

// TD LLC company info
const TD_COMPANY = {
  name: 'Tony Durante LLC',
  address: '1111 Lincoln Road, Suite 400, Miami Beach, FL 33139',
  state: 'Florida',
  ein: '32-0754285',
}

// Bank details by currency
const BANK_DETAILS: Record<string, InvoicePdfInput['bankDetails']> = {
  USD: {
    label: 'Relay — USD',
    accountHolder: 'Tony Durante LLC',
    bankName: 'Thread Bank',
    accountNumber: '200000306770',
    routingNumber: '064209588',
  },
  EUR: {
    label: 'Banking Circle — EUR',
    bankName: 'Banking Circle S.A.',
    iban: 'DK8989000023658198',
    swiftBic: 'SXPYDKKK',
    accountHolder: 'Tony Durante LLC',
  },
}

/**
 * POST /api/invoices/[id]/send — Send TD LLC invoice email with PDF attachment (dashboard auth)
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Fetch payment + items + account + contact
  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select('*')
    .eq('id', id)
    .not('invoice_status', 'is', null)
    .single()

  if (!payment) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

  // Only send Draft or Overdue invoices (re-send)
  if (!['Draft', 'Overdue'].includes(payment.invoice_status)) {
    return NextResponse.json(
      { error: `Cannot send invoice with status "${payment.invoice_status}"` },
      { status: 400 }
    )
  }

  const { data: items } = await supabaseAdmin
    .from('payment_items')
    .select('description, quantity, unit_price, amount, sort_order')
    .eq('payment_id', id)
    .order('sort_order')

  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('company_name, physical_address, ein_number')
    .eq('id', payment.account_id)
    .single()

  // Get primary contact email for sending
  const { data: contactLink } = await supabaseAdmin
    .from('account_contacts')
    .select('contacts(first_name, last_name, email)')
    .eq('account_id', payment.account_id)
    .eq('role', 'Owner')
    .limit(1)
    .maybeSingle()

  const contact = (contactLink as unknown as { contacts: { first_name: string; last_name: string; email: string } })?.contacts

  if (!contact?.email) {
    return NextResponse.json({ error: 'No contact email found for this account' }, { status: 400 })
  }

  const isCredit = payment.invoice_status === 'Credit'
  const currency = payment.amount_currency ?? 'USD'
  const csym = currency === 'EUR' ? '\u20AC' : '$'
  const bankDetails = BANK_DETAILS[currency] ?? BANK_DETAILS.USD
  const clientName = contact.first_name
    ? `${contact.first_name} ${contact.last_name ?? ''}`.trim()
    : account?.company_name ?? 'Client'

  // Use safeSend: send email FIRST, update DB AFTER
  const result = await safeSend({
    idempotencyCheck: async () => {
      if (payment.sent_at && payment.invoice_status === 'Sent') {
        return { alreadySent: true, message: `Invoice already sent on ${payment.sent_at}` }
      }
      return null
    },

    sendFn: async () => {
      // Generate PDF
      const pdfInput: InvoicePdfInput = {
        companyName: TD_COMPANY.name,
        companyAddress: TD_COMPANY.address,
        companyState: TD_COMPANY.state,
        companyEin: TD_COMPANY.ein,
        documentType: isCredit ? 'CREDIT NOTE' : 'INVOICE',
        invoiceNumber: payment.invoice_number ?? 'DRAFT',
        status: payment.invoice_status,
        currency,
        issueDate: payment.issue_date ?? new Date().toISOString().split('T')[0],
        dueDate: payment.due_date,
        billTo: {
          name: account?.company_name ?? 'Client',
          email: contact.email,
          address: account?.physical_address ?? null,
        },
        items: items ?? [],
        subtotal: Number(payment.subtotal ?? 0),
        discount: Number(payment.discount ?? 0),
        total: Number(payment.total ?? payment.amount ?? 0),
        message: payment.message,
        bankDetails,
      }

      const pdfBytes = await generateInvoicePdf(pdfInput)
      const pdfBase64 = Buffer.from(pdfBytes).toString('base64')

      // Build HTML email
      const invoiceNumber = payment.invoice_number ?? 'DRAFT'
      const total = Number(payment.total ?? payment.amount ?? 0)
      const subject = isCredit
        ? `Credit Note ${invoiceNumber} from Tony Durante LLC`
        : `Invoice ${invoiceNumber} from Tony Durante LLC`

      const html = buildInvoiceEmailHtml({
        clientName,
        invoiceNumber,
        issueDate: payment.issue_date ?? new Date().toISOString().split('T')[0],
        dueDate: payment.due_date,
        total,
        csym,
        isCredit,
        message: payment.message,
        bankDetails,
      })

      const rawEmail = createRawEmail({
        from: 'Tony Durante LLC <support@tonydurante.us>',
        to: contact.email,
        subject,
        html,
        attachment: { base64: pdfBase64, filename: `${invoiceNumber}.pdf` },
      })

      return gmailPost('/messages/send', { raw: rawEmail })
    },

    postSendSteps: [
      {
        name: 'update_invoice_status',
        fn: async () => {
          await supabaseAdmin
            .from('payments')
            .update({
              invoice_status: 'Sent',
              sent_at: new Date().toISOString(),
              sent_to: contact.email,
              updated_at: new Date().toISOString(),
            })
            .eq('id', id)
        },
      },
      {
        name: 'qb_sync',
        fn: async () => {
          await syncInvoiceToQB(id)
        },
      },
    ],
  })

  if (result.alreadySent) {
    return NextResponse.json({ success: true, message: result.idempotencyMessage })
  }

  if (result.hasWarnings) {
    return NextResponse.json({
      success: true,
      warning: 'Email sent but some post-send steps failed',
      steps: result.steps,
    })
  }

  return NextResponse.json({ success: true })
}

// ─── Email Helpers ──────────────────────────────────────

function buildInvoiceEmailHtml(opts: {
  clientName: string
  invoiceNumber: string
  issueDate: string
  dueDate?: string | null
  total: number
  csym: string
  isCredit: boolean
  message?: string | null
  bankDetails: InvoicePdfInput['bankDetails']
}): string {
  const accentColor = opts.isCredit ? '#7c3aed' : '#2563eb'
  const docLabel = opts.isCredit ? 'Credit Note' : 'Invoice'

  const bankHtml = opts.bankDetails ? (() => {
    const fields = [
      opts.bankDetails.accountHolder && `Account Holder: ${opts.bankDetails.accountHolder}`,
      opts.bankDetails.bankName && `Bank: ${opts.bankDetails.bankName}`,
      opts.bankDetails.iban && `IBAN: ${opts.bankDetails.iban}`,
      opts.bankDetails.swiftBic && `SWIFT/BIC: ${opts.bankDetails.swiftBic}`,
      opts.bankDetails.accountNumber && `Account: ${opts.bankDetails.accountNumber}`,
      opts.bankDetails.routingNumber && `Routing: ${opts.bankDetails.routingNumber}`,
    ].filter(Boolean).join('<br/>')
    return `<div style="background: #f0fdf4; padding: 16px; border-radius: 8px; margin-top: 16px; border: 1px solid #bbf7d0;">
      <p style="margin: 0; font-size: 12px; color: #15803d; text-transform: uppercase; font-weight: bold;">Bank Details — ${opts.bankDetails.label}</p>
      <p style="margin: 8px 0 0; font-size: 13px; color: #166534;">${fields}</p>
    </div>`
  })() : ''

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${accentColor}; padding: 24px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 20px;">Tony Durante LLC</h1>
        <p style="color: rgba(255,255,255,0.8); margin: 4px 0 0; font-size: 13px;">${docLabel}</p>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
        <p>Dear ${opts.clientName},</p>
        <p>${opts.isCredit
          ? `Please find attached credit note <strong>${opts.invoiceNumber}</strong>.`
          : `Please find attached invoice <strong>${opts.invoiceNumber}</strong> for your review.`
        }</p>

        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr style="background: #f8fafc;">
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">${docLabel} Number</td>
            <td style="padding: 8px 12px; font-size: 14px;">${opts.invoiceNumber}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Issue Date</td>
            <td style="padding: 8px 12px; font-size: 14px;">${opts.issueDate}</td>
          </tr>
          ${!opts.isCredit && opts.dueDate ? `<tr style="background: #f8fafc;">
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Due Date</td>
            <td style="padding: 8px 12px; font-size: 14px;">${opts.dueDate}</td>
          </tr>` : ''}
          <tr${!opts.isCredit && opts.dueDate ? '' : ' style="background: #f8fafc;"'}>
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">Total</td>
            <td style="padding: 8px 12px; font-size: 18px; font-weight: bold; color: ${accentColor};">
              ${opts.isCredit ? '-' : ''}${opts.csym}${Math.abs(opts.total).toFixed(2)}
            </td>
          </tr>
        </table>

        ${opts.message ? `<div style="background: #f8fafc; padding: 16px; border-radius: 8px; margin-top: 16px;">
          <p style="margin: 0; font-size: 12px; color: #6b7280; text-transform: uppercase; font-weight: bold;">Payment Terms</p>
          <p style="margin: 8px 0 0; font-size: 14px; white-space: pre-wrap;">${opts.message}</p>
        </div>` : ''}

        ${!opts.isCredit ? bankHtml : ''}

        <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">
          The PDF invoice is attached to this email. If you have any questions, please reply directly.
        </p>

        <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; font-size: 11px; color: #9ca3af;">
          Tony Durante LLC · 1111 Lincoln Road, Suite 400, Miami Beach, FL 33139
        </div>
      </div>
    </div>
  `
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
