/**
 * Invoice Auto-Send — Server-side helper for sending TD invoices with PDF.
 *
 * Used by:
 *  - Cron jobs (annual-installments) via autoSendInvoices()
 *  - Dashboard "Create & Send" via sendTDInvoice() called from finance/actions.ts
 *
 * Produces: PDF attachment + HTML email + multipart/mixed MIME, with bank
 * details resolved dynamically from payments.bank_preference (falls back to
 * 'auto' when null, which picks Relay USD or Airwallex EUR by currency).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailPost } from "@/lib/gmail"
import { generateInvoicePdf, type InvoicePdfInput } from "@/lib/pdf/invoice-pdf"
import { syncInvoiceToQB } from "@/lib/qb-sync"
import { getBankDetailsByPreference, type BankPreference } from "@/app/offer/[token]/contract/bank-defaults"
import { buildInvoiceEmail, buildPortalInvoiceUrl } from "@/lib/email/invoice-email"
import { ensurePayToken, resolveInvoiceAudience } from "@/lib/portal/pay-token"

// TD LLC company info
const TD_COMPANY = {
  name: "Tony Durante LLC",
  address: "1111 Lincoln Road, Suite 400, Miami Beach, FL 33139",
  state: "Florida",
  ein: "32-0754285",
}

/**
 * Resolve bank details for a payment row into the shape generateInvoicePdf +
 * buildAutoSendEmail expect. Reads payments.bank_preference; if null, falls
 * back to 'auto' which maps to Relay (USD) or Airwallex (EUR) via currency.
 */
function resolveBankDetails(
  preference: string | null | undefined,
  currency: "USD" | "EUR",
): NonNullable<InvoicePdfInput["bankDetails"]> {
  const pref = (preference ?? "auto") as BankPreference
  const bd = getBankDetailsByPreference(pref, currency)
  const effectivePref: BankPreference = pref === "auto"
    ? (currency === "USD" ? "relay" : "airwallex")
    : pref
  const label = `${effectivePref.charAt(0).toUpperCase()}${effectivePref.slice(1)} — ${currency}`
  return {
    label,
    accountHolder: bd.beneficiary ?? "Tony Durante LLC",
    bankName: bd.bank_name ?? null,
    iban: bd.iban ?? null,
    swiftBic: bd.bic ?? null,
    accountNumber: bd.account_number ?? null,
    routingNumber: bd.routing_number ?? null,
  }
}

interface AutoSendResult {
  paymentId: string
  success: boolean
  error?: string
}

/**
 * Auto-send multiple invoices. Used by cron jobs (annual-installments).
 * For each payment ID: generates PDF, emails client, updates status, syncs to QB.
 */
export async function autoSendInvoices(paymentIds: string[]): Promise<AutoSendResult[]> {
  const results: AutoSendResult[] = []

  for (const paymentId of paymentIds) {
    try {
      await sendTDInvoice(paymentId)
      results.push({ paymentId, success: true })
    } catch (err) {
      results.push({ paymentId, success: false, error: (err as Error).message })
    }
  }

  return results
}

/**
 * Single source of truth for sending a TD invoice with PDF + HTML email.
 *
 * Called by:
 *  - autoSendInvoices() (cron) — no opts, uses role='Owner' contact lookup
 *  - sendNewInvoice() (dashboard wrapper) — passes recipientEmail + clientName
 *    from its own flexible contact resolution (contact_id → first account_contacts)
 *
 * Steps:
 *  1. Fetch payment (must be Draft)
 *  2. Fetch payment_items + account
 *  3. Resolve recipient (from opts OR account_contacts where role='Owner')
 *  4. Resolve bank_details via payments.bank_preference → getBankDetailsByPreference
 *  5. Generate PDF via generateInvoicePdf
 *  6. Build HTML body via buildAutoSendEmail
 *  7. Send via Gmail (multipart/mixed with PDF attachment)
 *  8. Update payments row: invoice_status='Sent', sent_at, sent_to
 *  9. Fire-and-forget QB sync
 */
export async function sendTDInvoice(
  paymentId: string,
  opts?: { recipientEmail?: string; clientName?: string },
): Promise<void> {
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

  // Resolve recipient: prefer opts override (dashboard path with flexible
  // contact resolution), fall back to cron-style role='Owner' lookup.
  let recipientEmail = opts?.recipientEmail ?? ""
  let recipientName = opts?.clientName ?? ""

  if (!recipientEmail) {
    const { data: contactLink } = await supabaseAdmin
      .from("account_contacts")
      .select("contacts(first_name, last_name, email)")
      .eq("account_id", payment.account_id)
      .eq("role", "Owner")
      .limit(1)
      .maybeSingle()

    const contact = (contactLink as unknown as { contacts: { first_name: string; last_name: string; email: string } })?.contacts
    if (!contact?.email) throw new Error("No contact email found for this account")
    recipientEmail = contact.email
    recipientName = contact.first_name
      ? `${contact.first_name} ${contact.last_name ?? ""}`.trim()
      : account?.company_name ?? "Client"
  }

  const currency: "USD" | "EUR" = (payment.amount_currency === "EUR" ? "EUR" : "USD")
  const csym = currency === "EUR" ? "€" : "$"
  // Dynamic bank resolution via payments.bank_preference. Null => 'auto'
  // => Relay USD or Airwallex EUR via getBankDetailsByPreference.
  const bankDetails = resolveBankDetails(payment.bank_preference, currency)
  const clientName = recipientName || account?.company_name || "Client"
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
      email: recipientEmail,
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

  // Resolve audience (portal vs no_portal). Portal-audience recipients get
  // a "log in to your portal to pay" CTA and NO bank details in the body,
  // per R092. No-portal recipients (One-Time customers + closed-portal
  // Clients) get a Pay-with-Card button (via /pay/<token> redirect) plus
  // inline bank details — that's their whole payment path.
  const audience = await resolveInvoiceAudience(
    { account_id: payment.account_id, contact_id: payment.contact_id },
    supabaseAdmin,
  )

  // Generate / reuse pay token only for no-portal audiences (no email link
  // = no token needed). Token lives on payments.pay_token so reminders and
  // resends reuse the same URL.
  const payToken = audience === "no_portal"
    ? await ensurePayToken(paymentId, supabaseAdmin)
    : null

  const { subject, html } = buildInvoiceEmail({
    purpose: "initial",
    audience,
    clientName,
    invoiceNumber,
    issueDate: pdfInput.issueDate,
    dueDate: payment.due_date,
    total,
    currencySymbol: csym,
    currency,
    payToken,
    // Portal audience gets NO bank details in the email per R092.
    bankDetails: audience === "no_portal" ? bankDetails : null,
    message: payment.message,
    portalInvoiceUrl: audience === "portal" ? buildPortalInvoiceUrl(paymentId) : undefined,
  })

  const boundary = `boundary_${Date.now()}`
  const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
  const parts = [
    "From: Tony Durante LLC <support@tonydurante.us>",
    `To: ${recipientEmail}`,
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

  // Update status AFTER successful send. Destructure {error} per the
  // silent-failure pattern fix from commit ebbb450.
  // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c: this send-status writeback on payments pre-dates the operations-layer routing and will move when that migration lands.
  const { error: updateErr } = await supabaseAdmin
    .from("payments")
    .update({
      invoice_status: "Sent",
      sent_at: new Date().toISOString(),
      sent_to: recipientEmail,
      updated_at: new Date().toISOString(),
    })
    .eq("id", paymentId)
  if (updateErr) throw new Error(`Failed to mark payment as Sent: ${updateErr.message}`)

  // QB sync (non-blocking)
  syncInvoiceToQB(paymentId).catch(() => {})
}

// Deprecated local buildAutoSendEmail removed — superseded by
// lib/email/invoice-email.ts::buildInvoiceEmail, which covers every
// purpose × audience combination (initial, reminder, credit, receipt) ×
// (portal, no_portal) with one shared shell.
