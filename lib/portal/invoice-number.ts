import { supabaseAdmin } from '@/lib/supabase-admin'

/**
 * Generate next invoice number.
 * Format: INV-NNNNNN (e.g., INV-001393) — matches QuickBooks numbering.
 * Global sequence — NOT scoped per account/contact.
 *
 * Checks BOTH client_invoices AND payments tables to find the true max,
 * then verifies the generated number doesn't already exist (retry loop
 * for concurrency safety).
 */
export async function generateInvoiceNumber(): Promise<string> {
  const prefix = 'INV-'

  // Find the highest invoice number across BOTH tables (global sequence)
  const [ciResult, pResult] = await Promise.all([
    supabaseAdmin
      .from('client_invoices')
      .select('invoice_number')
      .like('invoice_number', `${prefix}%`)
      .order('invoice_number', { ascending: false })
      .limit(1),
    supabaseAdmin
      .from('payments')
      .select('invoice_number')
      .like('invoice_number', `${prefix}%`)
      .order('invoice_number', { ascending: false })
      .limit(1),
  ])

  let maxSeq = 0
  for (const result of [ciResult, pResult]) {
    if (result.data && result.data.length > 0) {
      const num = parseInt(result.data[0].invoice_number.replace(prefix, ''), 10)
      if (!isNaN(num) && num > maxSeq) maxSeq = num
    }
  }

  // Retry loop: if the generated number already exists, increment and try again
  const maxRetries = 5
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const seq = maxSeq + 1 + attempt
    const candidate = `${prefix}${String(seq).padStart(6, '0')}`

    // Check both tables for collision
    const [ciCheck, pCheck] = await Promise.all([
      supabaseAdmin
        .from('client_invoices')
        .select('id')
        .eq('invoice_number', candidate)
        .limit(1),
      supabaseAdmin
        .from('payments')
        .select('id')
        .eq('invoice_number', candidate)
        .limit(1),
    ])

    const exists =
      (ciCheck.data && ciCheck.data.length > 0) ||
      (pCheck.data && pCheck.data.length > 0)

    if (!exists) return candidate
  }

  // Fallback: use timestamp-based suffix to guarantee uniqueness
  const ts = Date.now().toString(36).toUpperCase()
  return `${prefix}${String(maxSeq + 1).padStart(6, '0')}-${ts}`
}
