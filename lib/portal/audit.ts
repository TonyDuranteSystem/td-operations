/**
 * Portal audit logging — lightweight action trail for security and debugging.
 * Logs to portal_audit_log table (fire-and-forget, never blocks the user).
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

export type PortalAction =
  | 'login'
  | 'login_failed'
  | 'password_change'
  | 'message_sent'
  | 'document_uploaded'
  | 'document_downloaded'
  | 'invoice_created'
  | 'invoice_sent'
  | 'invoice_pdf'
  | 'tax_doc_uploaded'
  | 'profile_updated'
  | 'language_changed'
  | 'account_switched'
  | 'file_uploaded'
  | 'settings_changed'

interface AuditEntry {
  user_id: string
  account_id?: string
  action: PortalAction
  detail?: string
  ip?: string
}

/**
 * Log a portal action. Fire-and-forget — never throws, never blocks.
 */
export function logPortalAction(entry: AuditEntry): void {
  Promise.resolve(
    supabaseAdmin
      .from('portal_audit_log')
      .insert({
        user_id: entry.user_id,
        account_id: entry.account_id || null,
        action: entry.action,
        detail: entry.detail || null,
        ip_address: entry.ip || null,
        created_at: new Date().toISOString(),
      })
  )
    .then(({ error }) => {
      if (error) console.error('[portal-audit] Log failed:', error.message)
    })
    .catch(() => {}) // swallow — audit should never affect UX
}
