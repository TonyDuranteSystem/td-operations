import { supabaseAdmin } from '@/lib/supabase-admin'

/**
 * Generate next invoice number for an account.
 * Format: INV-{YEAR}-{SEQ} (e.g., INV-2026-001)
 * Scoped per account — each LLC has its own sequence.
 * UNIQUE constraint on (account_id, invoice_number) with retry on collision.
 */
export async function generateInvoiceNumber(accountId: string): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `INV-${year}-`

  const { data } = await supabaseAdmin
    .from('client_invoices')
    .select('invoice_number')
    .eq('account_id', accountId)
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
