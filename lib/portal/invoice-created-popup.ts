/** The "Invoice created, what next?" pop-up can be turned off per browser (dev job 1a23f5f1, Antonio 2026-10-17). */
export const INVOICE_CREATED_POPUP_OFF_KEY = 'td-invoice-created-popup-off-v1'

/** Broken or blocked storage never hides the pop-up: it simply shows. */
export function invoiceCreatedPopupIsOff(): boolean {
  try { return window.localStorage.getItem(INVOICE_CREATED_POPUP_OFF_KEY) === '1' } catch { return false }
}

export function turnInvoiceCreatedPopupOff(): void {
  try { window.localStorage.setItem(INVOICE_CREATED_POPUP_OFF_KEY, '1') } catch { /* no-op */ }
}
