import { supabaseAdmin } from '@/lib/supabase-admin'

/**
 * Generate next invoice number.
 * Format: INV-NNNNNN (e.g., INV-001393) — matches QuickBooks numbering.
 * Global sequence — NOT scoped per account/contact.
 * This ensures our system and QB stay in sync.
 */
export async function generateInvoiceNumber(): Promise<string> {
  const prefix = 'INV-'

  // Find the highest invoice number across ALL invoices (global sequence)
  const { data } = await supabaseAdmin
    .from('client_invoices')
    .select('invoice_number')
    .like('invoice_number', `${prefix}%`)
    .order('invoice_number', { ascending: false })
    .limit(1)

  let seq = 1
  if (data && data.length > 0) {
    const lastNum = data[0].invoice_number.replace(prefix, '')
    const parsed = parseInt(lastNum, 10)
    if (!isNaN(parsed)) seq = parsed + 1
  }

  return `${prefix}${String(seq).padStart(6, '0')}`
}
