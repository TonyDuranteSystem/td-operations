import { supabaseAdmin } from '@/lib/supabase-admin'

/**
 * Generate next TD LLC invoice number.
 * Format: TD-{YEAR}-{SEQ} (e.g., TD-2026-001)
 * Global sequence (not per-account) — all TD LLC invoices share one counter.
 */
export async function generateInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `TD-${year}-`

  const { data } = await supabaseAdmin
    .from('payments')
    .select('invoice_number')
    .not('invoice_number', 'is', null)
    .like('invoice_number', `${prefix}%`)
    .order('invoice_number', { ascending: false })
    .limit(1)

  let seq = 1
  if (data && data.length > 0 && data[0].invoice_number) {
    const lastNum = data[0].invoice_number.replace(prefix, '')
    const parsed = parseInt(lastNum, 10)
    if (!isNaN(parsed)) seq = parsed + 1
  }

  return `${prefix}${String(seq).padStart(3, '0')}`
}
