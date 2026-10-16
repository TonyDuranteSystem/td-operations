/**
 * How a CLIENT's invoice emails (Send and reminders) leave the system (dev job 1a23f5f1, Antonio 2026-10-16).
 *
 * Two senders:
 *  - 'gmail'  the original path: our support@ mailbox, with the client's company as the display name.
 *  - 'resend' the new path: a dedicated invoicing address on its own domain (tdinvoice.com) through Resend, with the
 *             client's company as the display name and the client's email as Reply-To. Customers never see "support".
 *
 * The choice is the app setting `invoice_email_sender`. It FAILS CLOSED to 'gmail' (today's behaviour): Resend is used
 * only when the setting says so AND the API key exists, so switching back is one setting and a missing key can never
 * stop invoices from going out.
 */
import { createRawEmail, fromHeader, headerSafe } from '@/lib/portal/invoice-email'

export type InvoiceSender = 'gmail' | 'resend'

/** The address clients' invoice emails come from on the new domain. Overridable per environment. */
export function invoiceFromAddress(): string {
  const configured = (process.env.INVOICE_FROM_ADDRESS ?? '').trim()
  return /^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+\.[^\s@<>",;:\\]+$/.test(configured) ? configured : 'invoices@tdinvoice.com'
}

/** The address used by the original Gmail path. */
export const GMAIL_FROM_ADDRESS = 'support@tonydurante.us'

/**
 * Resend only when the setting asks for it AND a key exists; anything else keeps today's Gmail path.
 * The setting is 'resend' (every company) or { sender: 'resend', account_ids: [...] } to start with chosen companies:
 * a company not on the list stays on Gmail. A list that is empty or not a list of ids means nobody (fails closed).
 */
export function resolveInvoiceSender(setting: unknown, hasResendKey: boolean, accountId?: string | null): InvoiceSender {
  if (!hasResendKey) return 'gmail'
  if (setting === 'resend') return 'resend'
  if (setting && typeof setting === 'object' && (setting as { sender?: unknown }).sender === 'resend') {
    const ids = (setting as { account_ids?: unknown }).account_ids
    if (ids === undefined) return 'resend'
    return Array.isArray(ids) && !!accountId && ids.includes(accountId) ? 'resend' : 'gmail'
  }
  return 'gmail'
}

export function fromAddressFor(sender: InvoiceSender): string {
  return sender === 'resend' ? invoiceFromAddress() : GMAIL_FROM_ADDRESS
}

export interface InvoiceEmail {
  sender: InvoiceSender
  fromName: string
  to: string
  subject: string
  html: string
  replyTo?: string
  attachment?: { base64: string; filename: string }
}

export interface DeliveryResult { provider: InvoiceSender; messageId: string | null; threadId: string | null }

const RESEND_URL = 'https://api.resend.com/emails'

/** Send one invoice email. Throws on any failure so the callers' "remove the claim row" path runs. */
export async function deliverInvoiceEmail(email: InvoiceEmail): Promise<DeliveryResult> {
  const fromAddress = fromAddressFor(email.sender)

  if (email.sender === 'gmail') {
    const { gmailPost } = await import('@/lib/gmail')
    const raw = createRawEmail({
      from: fromHeader(email.fromName, fromAddress),
      to: email.to,
      subject: email.subject,
      html: email.html,
      replyTo: email.replyTo,
      attachment: email.attachment,
    })
    const res = await gmailPost('/messages/send', { raw }) as { id?: string; threadId?: string }
    return { provider: 'gmail', messageId: res?.id ?? null, threadId: res?.threadId ?? null }
  }

  // Sandbox never delivers real mail: record what WOULD have been sent so a tester can read it (same as the Gmail path).
  if (process.env.SANDBOX_MODE === '1') {
    const raw = createRawEmail({
      from: fromHeader(email.fromName, fromAddress),
      to: email.to,
      subject: email.subject,
      html: email.html,
      replyTo: email.replyTo,
      attachment: email.attachment,
    })
    console.warn('[SANDBOX] Resend email blocked:', { to: email.to, subject: email.subject })
    void import('@/lib/sandbox-mail-capture').then(m => m.captureSandboxEmail(raw)).catch(() => undefined)
    return { provider: 'resend', messageId: 'sandbox-blocked', threadId: null }
  }

  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY is not set')
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${headerSafe(email.fromName).replace(/[<>"]/g, '') || 'Invoices'} <${fromAddress}>`,
      to: [email.to],
      subject: headerSafe(email.subject),
      html: email.html,
      ...(email.replyTo ? { reply_to: email.replyTo } : {}),
      ...(email.attachment ? { attachments: [{ filename: email.attachment.filename, content: email.attachment.base64 }] } : {}),
    }),
  })
  if (!res.ok) {
    let detail = ''
    try { detail = ((await res.json()) as { message?: string })?.message ?? '' } catch { /* body is not JSON */ }
    throw new Error(`Resend refused the email (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  const body = await res.json().catch(() => ({})) as { id?: string }
  return { provider: 'resend', messageId: body.id ?? null, threadId: null }
}
