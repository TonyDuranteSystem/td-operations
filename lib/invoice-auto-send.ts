/**
 * Invoice Auto-Send — Server-side helper for automated invoice sending
 *
 * Used by cron jobs and other server-side processes that don't have
 * dashboard auth context. Sends invoice emails with PDF attachments.
 *
 * For dashboard/UI sends, use the /api/invoices/[id]/send route instead.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailPost } from "@/lib/gmail"
import { generateInvoicePdf, type InvoicePdfInput } from "@/lib/pdf/invoice-pdf"
import { syncInvoiceToQB } from "@/lib/qb-sync"

// TD LLC company info
const TD_COMPANY = {
  name: "Tony Durante LLC",
  address: "1111 Lincoln Road, Suite 400, Miami Beach, FL 33139",
  state: "Florida",
  ein: "32-0754285",
}

const BANK_DETAILS: Record<string, InvoicePdfInput["bankDetails"]> = {
  USD: {
    label: "Relay — USD",
    accountHolder: "Tony Durante LLC",
    bankName: "Thread Bank",
    accountNumber: "200000306770",
    routingNumber: "064209588",
  },
  EUR: {
    label: "Banking Circle — EUR",
    bankName: "Banking Circle S.A.",
    iban: "DK8989000023658198",
    swiftBic: "SXPYDKKK",
    accountHolder: "Tony Durante LLC",
  },
}

interface AutoSendResult {
  paymentId: string
  success: boolean
  error?: string
}

/**
 * Auto-send multiple invoices. Used by cron jobs.
 * For each payment ID: generates PDF, emails client, updates status, syncs to QB.
 */
export async function autoSendInvoices(paymentIds: string[]): Promise<AutoSendResult[]> {
  const results: AutoSendResult[] = []

  for (const paymentId of paymentIds) {
    try {
      await autoSendSingleInvoice(paymentId)
      results.push({ paymentId, success: true })
    } catch (err) {
      results.push({ paymentId, success: false, error: (err as Error).message })
    }
  }

  return results
}

async function autoSendSingleInvoice(paymentId: string): Promise<void> {
  // Fetch payment + items + account + contact
  const { data: payment, error: pErr } = await supabaseAdmin
    .from("payments")
    .select("*")
    .eq("id", paymentId)
    .not("invoice_status", "is", null)
    .single()

  if (pErr || !payment) throw new Error(`Payment not found: ${pErr?.message}`)

  // Skip if already sent
  if (payment.invoice_status === "Sent") return

  // Only send Draft invoices
  if (payment.invoice_status !== "Draft") {
    throw new Error(`Cannot send invoice with status "${payment.invoice_status}"`)
  }

  const { data: items } = await supabaseAdmin
    .from("payment_items")
    .select("description, quantity, unit_price, amount, sort_order")
    .eq("payment_id", paymentId)
    .order("sort_order")

  const { data: account } = await supabaseAdmin
    .from("accounts")
    .select("company_name, physical_address")
    .eq("id", payment.account_id)
    .single()

  // Get primary contact email
  const { data: contactLink } = await supabaseAdmin
    .from("account_contacts")
    .select("contacts(first_name, last_name, email)")
    .eq("account_id", payment.account_id)
    .eq("role", "Owner")
    .limit(1)
    .maybeSingle()

  const contact = (contactLink as unknown as { contacts: { first_name: string; last_name: string; email: string } })?.contacts

  if (!contact?.email) throw new Error("No contact email found for this account")

  const currency = payment.amount_currency ?? "USD"
  const csym = currency === "EUR" ? "€" : "$"
  const bankDetails = BANK_DETAILS[currency] ?? BANK_DETAILS.USD
  const clientName = contact.first_name
    ? `${contact.first_name} ${contact.last_name ?? ""}`.trim()
    : account?.company_name ?? "Client"
  const invoiceNumber = payment.invoice_number ?? "DRAFT"
  const total = Number(payment.total ?? payment.amount ?? 0)

  // Generate PDF
  const pdfInput: InvoicePdfInput = {
    companyName: TD_COMPANY.name,
    companyAddress: TD_COMPANY.address,
    companyState: TD_COMPANY.state,
    companyEin: TD_COMPANY.ein,
    documentType: "INVOICE",
    invoiceNumber,
    status: payment.invoice_status,
    currency,
    issueDate: payment.issue_date ?? new Date().toISOString().split("T")[0],
    dueDate: payment.due_date,
    billTo: {
      name: account?.company_name ?? "Client",
      email: contact.email,
      address: account?.physical_address ?? null,
    },
    items: items ?? [],
    subtotal: Number(payment.subtotal ?? 0),
    discount: Number(payment.discount ?? 0),
    total,
    message: payment.message,
    bankDetails,
  }

  const pdfBytes = await generateInvoicePdf(pdfInput)
  const pdfBase64 = Buffer.from(pdfBytes).toString("base64")

  // Build email
  const subject = `Invoice ${invoiceNumber} from Tony Durante LLC`
  const html = buildAutoSendEmail({ clientName, invoiceNumber, issueDate: pdfInput.issueDate, dueDate: payment.due_date, total, csym, bankDetails })

  const boundary = `boundary_${Date.now()}`
  const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
  const parts = [
    "From: Tony Durante LLC <support@tonydurante.us>",
    `To: ${contact.email}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html).toString("base64"),
    `--${boundary}`,
    `Content-Type: application/pdf; name="${invoiceNumber}.pdf"`,
    `Content-Disposition: attachment; filename="${invoiceNumber}.pdf"`,
    "Content-Transfer-Encoding: base64",
    "",
    pdfBase64,
    `--${boundary}--`,
  ]

  const raw = Buffer.from(parts.join("\r\n")).toString("base64url")

  // Send email FIRST
  await gmailPost("/messages/send", { raw })

  // Update status AFTER successful send
  await supabaseAdmin
    .from("payments")
    .update({
      invoice_status: "Sent",
      sent_at: new Date().toISOString(),
      sent_to: contact.email,
      updated_at: new Date().toISOString(),
    })
    .eq("id", paymentId)

  // QB sync (non-blocking)
  syncInvoiceToQB(paymentId).catch(() => {})
}

function buildAutoSendEmail(opts: {
  clientName: string
  invoiceNumber: string
  issueDate: string
  dueDate?: string | null
  total: number
  csym: string
  bankDetails: InvoicePdfInput["bankDetails"]
}): string {
  const bankHtml = opts.bankDetails
    ? (() => {
        const fields = [
          opts.bankDetails.accountHolder && `Account Holder: ${opts.bankDetails.accountHolder}`,
          opts.bankDetails.bankName && `Bank: ${opts.bankDetails.bankName}`,
          opts.bankDetails.iban && `IBAN: ${opts.bankDetails.iban}`,
          opts.bankDetails.swiftBic && `SWIFT/BIC: ${opts.bankDetails.swiftBic}`,
          opts.bankDetails.accountNumber && `Account: ${opts.bankDetails.accountNumber}`,
          opts.bankDetails.routingNumber && `Routing: ${opts.bankDetails.routingNumber}`,
        ]
          .filter(Boolean)
          .join("<br/>")
        return `<div style="background:#f0fdf4;padding:16px;border-radius:8px;margin-top:16px;border:1px solid #bbf7d0;">
      <p style="margin:0;font-size:12px;color:#15803d;text-transform:uppercase;font-weight:bold;">Bank Details — ${opts.bankDetails.label}</p>
      <p style="margin:8px 0 0;font-size:13px;color:#166534;">${fields}</p>
    </div>`
      })()
    : ""

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#2563eb;padding:24px;border-radius:12px 12px 0 0;">
        <h1 style="color:white;margin:0;font-size:20px;">Tony Durante LLC</h1>
        <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:13px;">Invoice</p>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
        <p>Dear ${opts.clientName},</p>
        <p>Please find attached invoice <strong>${opts.invoiceNumber}</strong> for your review.</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0;">
          <tr style="background:#f8fafc;">
            <td style="padding:8px 12px;font-weight:bold;color:#6b7280;font-size:13px;">Invoice Number</td>
            <td style="padding:8px 12px;font-size:14px;">${opts.invoiceNumber}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;font-weight:bold;color:#6b7280;font-size:13px;">Issue Date</td>
            <td style="padding:8px 12px;font-size:14px;">${opts.issueDate}</td>
          </tr>
          ${opts.dueDate ? `<tr style="background:#f8fafc;">
            <td style="padding:8px 12px;font-weight:bold;color:#6b7280;font-size:13px;">Due Date</td>
            <td style="padding:8px 12px;font-size:14px;">${opts.dueDate}</td>
          </tr>` : ""}
          <tr>
            <td style="padding:8px 12px;font-weight:bold;color:#6b7280;font-size:13px;">Total</td>
            <td style="padding:8px 12px;font-size:18px;font-weight:bold;color:#2563eb;">${opts.csym}${opts.total.toFixed(2)}</td>
          </tr>
        </table>
        ${bankHtml}
        <p style="color:#6b7280;font-size:13px;margin-top:24px;">
          The PDF invoice is attached to this email. If you have any questions, please reply directly.
        </p>
        <div style="border-top:1px solid #e5e7eb;margin-top:24px;padding-top:16px;font-size:11px;color:#9ca3af;">
          Tony Durante LLC · 1111 Lincoln Road, Suite 400, Miami Beach, FL 33139
        </div>
      </div>
    </div>
  `
}
