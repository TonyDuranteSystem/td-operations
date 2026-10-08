/**
 * ONE table for what each client sales-invoice status means (dev job 1a23f5f1, plan: sysdoc
 * `client-invoicing-plan`, section 6b). The PDF stamp, the row actions and the totals all read it,
 * so a status can no longer mean one thing on the PDF and another in the list.
 *
 * LOCKED IN CODE on purpose: statuses and their moves decide what a client's customer sees on a
 * money document. They are not an editable setting.
 *
 * 'Sent' has no watermark: that is the clean invoice the customer should receive.
 */

export type WatermarkColor = [number, number, number]

export interface InvoiceStatusRule {
  /** Text stamped across the PDF; null = clean PDF. */
  watermark: { text: string; color: WatermarkColor } | null
  editable: boolean
  voidable: boolean
  /** The Send button is offered (and the /send route moves it to Sent). */
  sendable: boolean
  /** A payment reminder makes sense. */
  remindable: boolean
  /** Counts in the "outstanding" total of the list. */
  outstanding: boolean
}

// Editing/voiding a Split parent would break its installment children; an already-Cancelled
// invoice has nothing left to edit or void.
export const INVOICE_STATUS: Record<string, InvoiceStatusRule> = {
  Draft:     { watermark: { text: 'DRAFT',     color: [0.7, 0.7, 0.7] }, editable: true,  voidable: true,  sendable: true,  remindable: false, outstanding: true },
  Sent:      { watermark: null,                                           editable: true,  voidable: true,  sendable: false, remindable: true,  outstanding: true },
  Overdue:   { watermark: { text: 'OVERDUE',   color: [0.9, 0.2, 0.2] }, editable: true,  voidable: true,  sendable: false, remindable: true,  outstanding: true },
  Partial:   { watermark: { text: 'PARTIAL',   color: [0.9, 0.6, 0.1] }, editable: true,  voidable: true,  sendable: false, remindable: false, outstanding: true },
  Paid:      { watermark: { text: 'PAID',      color: [0.2, 0.8, 0.2] }, editable: true,  voidable: true,  sendable: false, remindable: false, outstanding: false },
  Cancelled: { watermark: { text: 'CANCELLED', color: [0.7, 0.7, 0.7] }, editable: false, voidable: false, sendable: false, remindable: false, outstanding: false },
  Split:     { watermark: null,                                           editable: false, voidable: false, sendable: false, remindable: false, outstanding: true },
}

export function invoiceStatusRule(status: string | null | undefined): InvoiceStatusRule | null {
  return INVOICE_STATUS[(status ?? '').trim()] ?? null
}

/**
 * The status the PDF must show when it is built for the email that is about to move a Draft to
 * Sent. The customer must never receive a DRAFT-stamped PDF. The invoice row itself is NOT changed
 * here; only after the email really went out does /send flip the stored status.
 */
export function pdfStatusForSend(status: string | null | undefined): string {
  const s = (status ?? '').trim()
  return s === 'Draft' ? 'Sent' : s
}

/** Only the Send route may ask for this, and only 'Sent' is accepted. */
export function resolvePdfStatus(stored: string, requestedAs: string | null | undefined): string {
  if (requestedAs === 'Sent' && stored === 'Draft') return 'Sent'
  return stored
}
