import { supabaseAdmin } from '@/lib/supabase-admin'

/**
 * Generate next invoice number.
 * Format: INV-{YEAR}-{SEQ} (e.g., INV-2026-001)
 * Scoped per owner — each account or contact has its own sequence.
 * Supports contact-only invoices (before any account exists).
 */
export async function generateInvoiceNumber(ownerId: string, ownerType: 'account' | 'contact' = 'account'): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `INV-${year}-`

  const col = ownerType === 'account' ? 'account_id' : 'contact_id'

  const { data } = await supabaseAdmin
    .from('client_invoices')
    .select('invoice_number')
    .eq(col, ownerId)
    .like('invoice_number', `${prefix}%`)
    .order('invoice_number', { ascending: false })
    .limit(1)

  let seq = 1
  if (data && data.length > 0) {
    const lastNum = data[0].invoice_number.replace(prefix, '')
    const parsed = parseInt(lastNum, 10)
    if (!isNaN(parsed)) seq = parsed + 1
  }

  return `${prefix}${String(seq).padStart(3, '0')}`
}
