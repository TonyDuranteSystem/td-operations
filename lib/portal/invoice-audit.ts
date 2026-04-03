/**
 * Invoice Audit Trail
 *
 * Logs all invoice write operations to invoice_audit_log.
 * Called from createUnifiedInvoice, syncInvoiceStatus, updateInvoice, etc.
 * Fire-and-forget (non-blocking) — never fails the parent operation.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

export type InvoiceAuditAction =
  | 'created'
  | 'sent'
  | 'paid'
  | 'partial_payment'
  | 'status_changed'
  | 'edited'
  | 'voided'
  | 'split'
  | 'credit_applied'

export interface InvoiceAuditEntry {
  invoice_id: string
  action: InvoiceAuditAction
  changed_fields?: Record<string, unknown>
  previous_values?: Record<string, unknown>
  new_values?: Record<string, unknown>
  performed_by?: string  // 'system', 'claude', 'antonio', 'luca', 'client', 'auto-reconcile'
}

/**
 * Log an audit entry. Fire-and-forget — errors are logged but never thrown.
 */
export function logInvoiceAudit(entry: InvoiceAuditEntry): void {
  Promise.resolve(
    supabaseAdmin
      .from('invoice_audit_log')
      .insert({
        invoice_id: entry.invoice_id,
        action: entry.action,
        changed_fields: entry.changed_fields ?? null,
        previous_values: entry.previous_values ?? null,
        new_values: entry.new_values ?? null,
        performed_by: entry.performed_by ?? 'system',
      })
  ).then(({ error }) => {
    if (error) console.error('[invoice-audit] Failed to log:', error.message)
  }).catch(() => {})
}
