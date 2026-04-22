/**
 * Shared TD invoice email builder.
 *
 * Produces { subject, html } for a given purpose × audience matrix:
 *   purpose:  'initial' | 'reminder' | 'credit' | 'receipt'
 *   audience: 'portal' (portal_tier='active') | 'no_portal' (everything else,
 *              including One-Time customers and closed-portal Clients)
 *
 * All 8 combinations share the same header/footer/TD identity; only the
 * call-to-action and payment-path block vary. Callers remain responsible
 * for attaching the PDF and sending the raw MIME via Gmail.
 *
 * Per R092 + Antonio's 2026-04-23 clarification:
 *   - Portal audience emails NEVER embed bank details or pay URLs; they
 *     direct the client to log into the portal to pay.
 *   - No-portal audience emails MUST include a stable pay URL + bank
 *     details (that's the whole payment path for them).
 */

import { randomBytes } from "crypto"
import { APP_BASE_URL, PORTAL_BASE_URL } from "@/lib/config"

export type InvoiceEmailPurpose = "initial" | "reminder" | "credit" | "receipt"
export type InvoiceEmailAudience = "portal" | "no_portal"

export interface InvoiceEmailInput {
  purpose: InvoiceEmailPurpose
  audience: InvoiceEmailAudience

  clientName: string
  invoiceNumber: string
  issueDate: string
  dueDate?: string | null
  total: number
  currencySymbol: string
  currency: string

  /** Opaque token for the stable /pay/<token> redirect. Required when
   *  audience='no_portal' AND purpose IN ('initial','reminder'). */
  payToken?: string | null

  /** Inline bank details (no_portal audiences only). */
  bankDetails?: {
    label: string
    accountHolder?: string | null
    bankName?: string | null
    iban?: string | null
    swiftBic?: string | null
    accountNumber?: string | null
    routingNumber?: string | null
  } | null

  /** Optional free-text message from the invoice record. Rendered in a
   *  neutral "notes" block between the invoice table and the payment CTA. */
  message?: string | null

  /** Deep link for portal audiences. When purpose='receipt', points at the
   *  paid-archive page instead of the open-invoice page. */
  portalInvoiceUrl?: string
}

export interface InvoiceEmailOutput {
  subject: string
  html: string
}

/** Generate a URL-safe opaque pay token. 32 bytes of entropy, base64url. */
export function generatePayToken(): string {
  return randomBytes(32).toString("base64url")
}

/** Build the stable /pay/<token> URL. Public, appears in emails. */
export function buildPayUrl(payToken: string): string {
  return `${APP_BASE_URL}/pay/${payToken}`
}

/** Build the portal deep-link to an invoice (open or paid). */
export function buildPortalInvoiceUrl(paymentId: string): string {
  return `${PORTAL_BASE_URL}/portal/invoices#td-${paymentId}`
}

/** Build the paid-archive deep link. */
export function buildPortalReceiptsUrl(): string {
  return `${PORTAL_BASE_URL}/portal/invoices?view=paid`
}

function subjectFor(input: InvoiceEmailInput): string {
  const n = input.invoiceNumber
  switch (input.purpose) {
    case "initial":
      return `Invoice ${n} from Tony Durante LLC`
    case "reminder":
      return `Reminder: Invoice ${n} from Tony Durante LLC`
    case "credit":
      return `Credit Note ${n} from Tony Durante LLC`
    case "receipt":
      return `Payment received for Invoice ${n}`
  }
}

function headerColorFor(purpose: InvoiceEmailPurpose): string {
  if (purpose === "credit") return "#7c3aed" // purple
  if (purpose === "receipt") return "#059669" // emerald
  return "#2563eb" // blue (initial + reminder)
}

function docLabelFor(purpose: InvoiceEmailPurpose): string {
  switch (purpose) {
    case "initial":
      return "Invoice"
    case "reminder":
      return "Invoice — Reminder"
    case "credit":
      return "Credit Note"
    case "receipt":
      return "Payment Receipt"
  }
}

function invoiceTableRows(input: InvoiceEmailInput): string {
  const rows: string[] = []
  rows.push(`<tr style="background:#f8fafc;">
    <td style="padding:8px 12px;font-weight:bold;color:#6b7280;font-size:13px;">Invoice Number</td>
    <td style="padding:8px 12px;font-size:14px;">${input.invoiceNumber}</td>
  </tr>`)
  rows.push(`<tr>
    <td style="padding:8px 12px;font-weight:bold;color:#6b7280;font-size:13px;">${input.purpose === "receipt" ? "Paid Date" : "Issue Date"}</td>
    <td style="padding:8px 12px;font-size:14px;">${input.issueDate}</td>
  </tr>`)
  if (input.purpose !== "receipt" && input.purpose !== "credit" && input.dueDate) {
    rows.push(`<tr style="background:#f8fafc;">
      <td style="padding:8px 12px;font-weight:bold;color:#6b7280;font-size:13px;">Due Date</td>
      <td style="padding:8px 12px;font-size:14px;">${input.dueDate}</td>
    </tr>`)
  }
  const totalLabel = input.purpose === "credit" ? "Credit Amount" : input.purpose === "receipt" ? "Amount Paid" : "Total"
  const totalPrefix = input.purpose === "credit" ? "-" : ""
  const totalColor = headerColorFor(input.purpose)
  rows.push(`<tr${input.purpose === "receipt" || input.purpose === "credit" ? ' style="background:#f8fafc;"' : ""}>
    <td style="padding:8px 12px;font-weight:bold;color:#6b7280;font-size:13px;">${totalLabel}</td>
    <td style="padding:8px 12px;font-size:18px;font-weight:bold;color:${totalColor};">
      ${totalPrefix}${input.currencySymbol}${Math.abs(input.total).toFixed(2)} ${input.currency}
    </td>
  </tr>`)
  return rows.join("")
}

function messageBlock(message: string | null | undefined): string {
  if (!message || !message.trim()) return ""
  // Escape HTML minimally and preserve line breaks.
  const safe = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  return `<div style="background:#f8fafc;padding:16px;border-radius:8px;margin-top:16px;">
    <p style="margin:0;font-size:12px;color:#6b7280;text-transform:uppercase;font-weight:bold;">Notes</p>
    <p style="margin:8px 0 0;font-size:14px;white-space:pre-wrap;">${safe}</p>
  </div>`
}

function bankDetailsBlock(bd: InvoiceEmailInput["bankDetails"]): string {
  if (!bd) return ""
  const fields = [
    bd.accountHolder && `Account Holder: ${bd.accountHolder}`,
    bd.bankName && `Bank: ${bd.bankName}`,
    bd.iban && `IBAN: ${bd.iban}`,
    bd.swiftBic && `SWIFT/BIC: ${bd.swiftBic}`,
    bd.accountNumber && `Account: ${bd.accountNumber}`,
    bd.routingNumber && `Routing: ${bd.routingNumber}`,
  ]
    .filter(Boolean)
    .join("<br/>")
  if (!fields) return ""
  return `<div style="background:#f0fdf4;padding:16px;border-radius:8px;margin-top:16px;border:1px solid #bbf7d0;">
    <p style="margin:0;font-size:12px;color:#15803d;text-transform:uppercase;font-weight:bold;">Bank Transfer — ${bd.label}</p>
    <p style="margin:8px 0 0;font-size:13px;color:#166534;">${fields}</p>
  </div>`
}

function ctaPortalOpen(portalInvoiceUrl: string): string {
  return `<div style="text-align:center;margin:28px 0;">
    <a href="${portalInvoiceUrl}"
       style="display:inline-block;padding:14px 28px;background:#2563eb;color:white;text-decoration:none;border-radius:8px;font-weight:bold;font-size:15px;">
      Log in to your portal to review &amp; pay
    </a>
  </div>`
}

function ctaPortalReceipt(portalReceiptsUrl: string): string {
  return `<div style="text-align:center;margin:28px 0;">
    <a href="${portalReceiptsUrl}"
       style="display:inline-block;padding:12px 24px;background:#059669;color:white;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px;">
      View paid invoices in your portal
    </a>
  </div>`
}

function ctaNoPortalOpen(payUrl: string): string {
  return `<div style="text-align:center;margin:28px 0;">
    <a href="${payUrl}"
       style="display:inline-block;padding:14px 28px;background:#2563eb;color:white;text-decoration:none;border-radius:8px;font-weight:bold;font-size:15px;">
      Pay with Card (Stripe)
    </a>
    <p style="margin:8px 0 0;font-size:12px;color:#6b7280;">One-click card payment. Alternatively, bank transfer details are below.</p>
  </div>`
}

function baseShell(input: InvoiceEmailInput, inner: string): string {
  const accent = headerColorFor(input.purpose)
  const doc = docLabelFor(input.purpose)
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:${accent};padding:24px;border-radius:12px 12px 0 0;">
        <h1 style="color:white;margin:0;font-size:20px;">Tony Durante LLC</h1>
        <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:13px;">${doc}</p>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px;">
        ${inner}
        <div style="border-top:1px solid #e5e7eb;margin-top:24px;padding-top:16px;font-size:11px;color:#9ca3af;">
          Tony Durante LLC · 1111 Lincoln Road, Suite 400, Miami Beach, FL 33139
        </div>
      </div>
    </div>
  `
}

/** Build the invoice email. Returns { subject, html }. */
export function buildInvoiceEmail(input: InvoiceEmailInput): InvoiceEmailOutput {
  const subject = subjectFor(input)
  const table = `<table style="width:100%;border-collapse:collapse;margin:20px 0;">${invoiceTableRows(input)}</table>`
  const msgBlock = messageBlock(input.message)

  const isPortal = input.audience === "portal"
  const isReceipt = input.purpose === "receipt"
  const isCredit = input.purpose === "credit"

  // Greeting + first paragraph by purpose
  const greeting = `<p>Dear ${input.clientName},</p>`
  let firstPara = ""
  switch (input.purpose) {
    case "initial":
      firstPara = `<p>Please find attached invoice <strong>${input.invoiceNumber}</strong> for your review.</p>`
      break
    case "reminder":
      firstPara = `<p>This is a friendly reminder that invoice <strong>${input.invoiceNumber}</strong> is awaiting payment. The PDF is attached.</p>`
      break
    case "credit":
      firstPara = `<p>Please find attached credit note <strong>${input.invoiceNumber}</strong>.</p>`
      break
    case "receipt":
      firstPara = `<p>We've received your payment for invoice <strong>${input.invoiceNumber}</strong>. Thank you! The paid PDF is attached.</p>`
      break
  }

  // Payment path block — only when a payment action is expected
  let paymentPath = ""
  if (!isReceipt && !isCredit) {
    if (isPortal) {
      const portalUrl = input.portalInvoiceUrl ?? buildPortalReceiptsUrl()
      paymentPath = ctaPortalOpen(portalUrl)
    } else {
      const payUrl = input.payToken ? buildPayUrl(input.payToken) : null
      paymentPath = (payUrl ? ctaNoPortalOpen(payUrl) : "") + bankDetailsBlock(input.bankDetails ?? null)
    }
  } else if (isReceipt && isPortal) {
    paymentPath = ctaPortalReceipt(buildPortalReceiptsUrl())
  }

  // Closing line
  const closingLine = isReceipt
    ? `<p style="color:#6b7280;font-size:13px;margin-top:24px;">No action required. If you have questions, reply directly to this email.</p>`
    : `<p style="color:#6b7280;font-size:13px;margin-top:24px;">The PDF is attached to this email. If you have questions, reply directly.</p>`

  const inner = `${greeting}${firstPara}${table}${msgBlock}${paymentPath}${closingLine}`
  const html = baseShell(input, inner)
  return { subject, html }
}
