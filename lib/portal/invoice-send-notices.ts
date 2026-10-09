/**
 * The notices a client sees on an invoice before sending it (dev job 1a23f5f1, plan: sysdoc
 * `client-invoicing-plan`, section 6b).
 *
 * LOCKED IN CODE on purpose: these are the minimum safety warnings. Wording comes from the portal
 * dictionary (English + Italian) and may be changed there, but the RULES below (when each notice
 * appears and whether it blocks Send) are not an editable setting; otherwise one edit could bring
 * back the dead end where a client could not send an invoice and was not told why.
 */
import { invoiceStatusRule } from './invoice-status'

export type SendNoticeId = 'draft-explainer' | 'no-customer-email' | 'no-payment-details'

export interface SendNotice {
  id: SendNoticeId
  /** true = Send cannot proceed until the problem is fixed; false = warn, "Send anyway" allowed. */
  blocksSend: boolean
}

export interface SendNoticeInput {
  status: string | null | undefined
  customerEmail: string | null | undefined
  hasBankAccount: boolean
  hasPaymentLink: boolean
}

// Same rule as isSafeRecipient (lib/portal/invoice-email.ts, which cannot be imported into the browser): one plain
// address, no spaces, commas, angle brackets or quotes, so what the banner accepts is what Send will accept.
const EMAIL_RE = /^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+\.[^\s@<>",;:\\]{2,}$/

export function isPlausibleEmail(value: string | null | undefined): boolean {
  return EMAIL_RE.test((value ?? '').trim())
}

export function sendNotices(input: SendNoticeInput): SendNotice[] {
  const rule = invoiceStatusRule(input.status)
  const notices: SendNotice[] = []
  if (!rule) return notices

  // A Draft always explains itself.
  if (input.status?.trim() === 'Draft') notices.push({ id: 'draft-explainer', blocksSend: false })

  // Sending (a Draft) or reminding (Sent/Overdue) both email the customer, so both need an address.
  if ((rule.sendable || rule.remindable) && !isPlausibleEmail(input.customerEmail)) {
    notices.push({ id: 'no-customer-email', blocksSend: true })
  }

  // A bank account OR a payment link tells the customer how to pay. Neither is a hard stop: some
  // clients are paid in cash or by arrangement, hence "Send anyway".
  if (rule.sendable && !input.hasBankAccount && !input.hasPaymentLink) {
    notices.push({ id: 'no-payment-details', blocksSend: false })
  }

  return notices
}
