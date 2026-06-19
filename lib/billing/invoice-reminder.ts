/**
 * Invoice payment reminder — SINGLE source of truth.
 *
 * Every reminder send goes through `sendInvoiceReminder()`:
 *   - the daily dunning cron (`/api/cron/invoice-overdue`) calls it DIRECTLY
 *     (no self-HTTP — the old internal fetch to VERCEL_URL hit the Vercel
 *     "Authentication Required" wall and sent ZERO reminders),
 *   - the dashboard route `POST /api/invoices/[id]/remind`,
 *   - the manual "Send Reminder" finance action.
 *
 * Recipient is resolved via the shared `resolvePaymentRecipient` (owner-role
 * case-insensitive → any contact → communication_email) — never a hand-rolled
 * `role = 'Owner'` lookup (the ADWise lowercase bug, 2026-06-18).
 *
 * The email is bilingual (EN/IT) by the recipient contact's `language`.
 *
 * This module does NOT decide cadence or the 2-reminder cap — that policy
 * lives in the cron (auto) and the bulk action (manual). It just sends one
 * reminder, bumps `reminder_count` / `last_reminder_at`, and writes an
 * `invoice_reminder_log` row (source = auto | manual) for the history UI.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { gmailPost } from "@/lib/gmail"
import { safeSend } from "@/lib/mcp/safe-send"
import { resolvePaymentRecipient } from "@/lib/portal/resolve-payment-recipient"

export interface ReminderResult {
  ok: boolean
  sent: boolean
  alreadySent?: boolean
  recipient?: string
  reminderNumber?: number
  error?: string
}

/** Statuses a reminder can be sent for. Draft is handled upstream (a Draft
 *  invoice must be SENT first, not reminded). */
const REMINDABLE_STATUSES = ["Sent", "Overdue", "Partial"] as const

export interface ReminderEmailInput {
  language: string | null
  clientName: string
  invoiceNumber: string
  amount: number
  currency: string
  dueDate: string | null
  isOverdue: boolean
}

/**
 * Pure, testable bilingual reminder email builder. EN by default; IT when
 * `language === 'it'`. Returns the RFC-2047-encodable subject + HTML body.
 */
export function buildReminderEmail(input: ReminderEmailInput): { subject: string; html: string } {
  const { language, clientName, invoiceNumber, amount, currency, dueDate, isOverdue } = input
  const isIt = (language ?? "en").toLowerCase().startsWith("it")
  const csym = currency === "EUR" ? "€" : "$"
  const accentColor = isOverdue ? "#dc2626" : "#f59e0b"
  const amountStr = `${csym}${amount.toFixed(2)}`

  const t = isIt
    ? {
        subject: isOverdue
          ? `Scaduta: Fattura ${invoiceNumber} — Tony Durante LLC`
          : `Promemoria: Fattura ${invoiceNumber} — Tony Durante LLC`,
        header: isOverdue ? "Pagamento Scaduto" : "Promemoria di Pagamento",
        greeting: `Gentile ${clientName},`,
        body: isOverdue
          ? `Le ricordiamo che la fattura <strong>${invoiceNumber}</strong> risulta ora scaduta.`
          : `Le inviamo un cortese promemoria riguardo alla fattura <strong>${invoiceNumber}</strong>.`,
        lblInvoice: "Fattura",
        lblAmount: "Importo Dovuto",
        lblDue: "Scadenza",
        disclaimer:
          "Se ha già effettuato il pagamento, ignori questo promemoria. Per qualsiasi domanda, risponda direttamente a questa email.",
      }
    : {
        subject: isOverdue
          ? `Overdue: Invoice ${invoiceNumber} — Tony Durante LLC`
          : `Reminder: Invoice ${invoiceNumber} — Tony Durante LLC`,
        header: isOverdue ? "Payment Overdue" : "Payment Reminder",
        greeting: `Dear ${clientName},`,
        body: isOverdue
          ? `This is a reminder that invoice <strong>${invoiceNumber}</strong> is now past due.`
          : `This is a friendly reminder regarding invoice <strong>${invoiceNumber}</strong>.`,
        lblInvoice: "Invoice",
        lblAmount: "Amount Due",
        lblDue: "Due Date",
        disclaimer:
          "If you have already sent payment, please disregard this reminder. For questions, reply directly to this email.",
      }

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: ${accentColor}; padding: 24px; border-radius: 12px 12px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 20px;">${t.header}</h1>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
        <p>${t.greeting}</p>
        <p>${t.body}</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr style="background: #f8fafc;">
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">${t.lblInvoice}</td>
            <td style="padding: 8px 12px; font-size: 14px;">${invoiceNumber}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">${t.lblAmount}</td>
            <td style="padding: 8px 12px; font-size: 18px; font-weight: bold; color: ${accentColor};">${amountStr}</td>
          </tr>
          ${
            dueDate
              ? `<tr style="background: #f8fafc;">
            <td style="padding: 8px 12px; font-weight: bold; color: #6b7280; font-size: 13px;">${t.lblDue}</td>
            <td style="padding: 8px 12px; font-size: 14px; ${isOverdue ? "color: #dc2626; font-weight: bold;" : ""}">${dueDate}</td>
          </tr>`
              : ""
          }
        </table>
        <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">${t.disclaimer}</p>
        <div style="border-top: 1px solid #e5e7eb; margin-top: 24px; padding-top: 16px; font-size: 11px; color: #9ca3af;">
          Tony Durante LLC · 10225 Ulmerton Rd, STE 3D, Largo FL 33771
        </div>
      </div>
    </div>
  `

  return { subject: t.subject, html }
}

/** Build the base64url MIME payload for the Gmail send. */
function buildRawEmail(to: string, subject: string, html: string): string {
  const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
  const boundary = `boundary_${Date.now()}`
  const rawEmail = [
    "From: Tony Durante LLC <support@tonydurante.us>",
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html).toString("base64"),
    `--${boundary}--`,
  ].join("\r\n")
  return Buffer.from(rawEmail).toString("base64url")
}

/**
 * Send one payment reminder for a TD invoice. Resolves the recipient + language,
 * builds the bilingual email, sends via Gmail (safeSend ordering), and bumps
 * `reminder_count` / `last_reminder_at`. Never throws — always returns a
 * structured result so callers (cron / bulk) can report per-invoice outcomes.
 */
export async function sendInvoiceReminder(
  paymentId: string,
  opts: { source?: "auto" | "manual" } = {},
): Promise<ReminderResult> {
  const source = opts.source ?? "manual"
  const { data: payment } = await supabaseAdmin
    .from("payments")
    .select("id, invoice_number, invoice_status, total, amount, amount_currency, due_date, account_id, contact_id, reminder_count")
    .eq("id", paymentId)
    .not("invoice_status", "is", null)
    .single()

  if (!payment) return { ok: false, sent: false, error: "Invoice not found" }

  if (!REMINDABLE_STATUSES.includes(payment.invoice_status as (typeof REMINDABLE_STATUSES)[number])) {
    return { ok: false, sent: false, error: `Cannot remind on invoice with status "${payment.invoice_status}"` }
  }

  const recipient = await resolvePaymentRecipient(
    { contact_id: payment.contact_id, account_id: payment.account_id },
    supabaseAdmin,
  )
  if (!recipient) return { ok: false, sent: false, error: "No contact email found" }

  const invoiceNumber = payment.invoice_number ?? "DRAFT"
  const reminderCount = Number(payment.reminder_count ?? 0)
  const { subject, html } = buildReminderEmail({
    language: recipient.language,
    clientName: recipient.name,
    invoiceNumber,
    amount: Number(payment.total ?? payment.amount ?? 0),
    currency: payment.amount_currency ?? "USD",
    dueDate: payment.due_date,
    isOverdue: payment.invoice_status === "Overdue",
  })

  try {
    const result = await safeSend({
      sendFn: async () => gmailPost("/messages/send", { raw: buildRawEmail(recipient.email, subject, html) }),
      postSendSteps: [
        {
          name: "update_reminder_count",
          fn: async () => {
            // eslint-disable-next-line no-restricted-syntax -- reminder_count / last_reminder_at have no dedicated helper
            await supabaseAdmin
              .from("payments")
              .update({
                reminder_count: reminderCount + 1,
                last_reminder_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("id", paymentId)
          },
        },
        {
          name: "write_reminder_log",
          fn: async () => {
            // invoice_reminder_log is newer than the generated DB types (the
            // repo doesn't regen types per migration), so cast `as never` —
            // same pattern as lib/portal/auto-save-document.ts.
            // eslint-disable-next-line no-restricted-syntax -- history audit insert; no dedicated helper
            await supabaseAdmin.from("invoice_reminder_log" as never).insert({
              payment_id: paymentId,
              account_id: payment.account_id,
              source,
              reminder_number: reminderCount + 1,
              recipient_email: recipient.email,
              language: recipient.language,
            } as never)
          },
        },
      ],
    })

    if (result.alreadySent) {
      return { ok: true, sent: false, alreadySent: true, recipient: recipient.email }
    }
    return { ok: true, sent: true, recipient: recipient.email, reminderNumber: reminderCount + 1 }
  } catch (err) {
    return { ok: false, sent: false, recipient: recipient.email, error: err instanceof Error ? err.message : String(err) }
  }
}
