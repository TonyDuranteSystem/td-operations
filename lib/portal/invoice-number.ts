import { supabaseAdmin } from '@/lib/supabase-admin'

/**
 * Generate next invoice number.
 * Format: INV-NNNNNN (e.g., INV-001393) — shared with QuickBooks DocNumber.
 * Global sequence — NOT scoped per account/contact.
 *
 * Checks BOTH client_invoices AND payments tables to find the true max.
 *
 * This function is NOT race-safe on its own — two concurrent callers may
 * compute the same candidate. Race safety is provided by the partial unique
 * indexes uq_payments_invoice_number and uq_client_invoices_invoice_number;
 * the caller must catch unique-violation (Postgres code 23505) on INSERT and
 * retry by calling this function again.
 *
 * No fallback format. No retry loop. No timestamp suffix. If the insert races,
 * the caller retries and gets the next number. Failure is loud, not silent.
 */
export async function generateInvoiceNumber(): Promise<string> {
  const prefix = 'INV-'

  // Find the highest invoice number across BOTH tables (global sequence).
  // Use strict-width LIKE pattern `INV-______` (6 underscores = exactly 6 chars after prefix)
  // to filter ONLY the canonical INV-NNNNNN format. Otherwise legacy oddities like
  // `INV-2026-001` would lex-sort above real numbers (e.g. INV-002135) and produce
  // a wrong max.
  // TODO: when sequential count exceeds 999999, the LIKE pattern needs to allow 7+ chars.
  const strictPattern = `${prefix}______` // 6 underscores → exactly 6 chars after prefix
  const [ciResult, pResult] = await Promise.all([
    supabaseAdmin
      .from('client_invoices')
      .select('invoice_number')
      .like('invoice_number', strictPattern)
      .order('invoice_number', { ascending: false })
      .limit(1),
    supabaseAdmin
      .from('payments')
      .select('invoice_number')
      .like('invoice_number', strictPattern)
      .order('invoice_number', { ascending: false })
      .limit(1),
  ])

  let maxSeq = 0
  for (const result of [ciResult, pResult]) {
    if (result.data && result.data.length > 0 && result.data[0].invoice_number) {
      const num = parseInt(result.data[0].invoice_number.replace(prefix, ''), 10)
      if (!isNaN(num) && num > maxSeq) maxSeq = num
    }
  }

  return `${prefix}${String(maxSeq + 1).padStart(6, '0')}`
}

/**
 * Detect a Postgres unique-violation error scoped to a specific constraint.
 * Postgres error code 23505 is unique_violation. The constraint name appears
 * in the message or details field depending on the client path.
 */
export function isUniqueViolation(
  error: { code?: string; message?: string; details?: string } | null | undefined,
  constraintName: string,
): boolean {
  if (!error) return false
  if (error.code !== '23505') return false
  const haystack = `${error.message ?? ''} ${error.details ?? ''}`
  return haystack.includes(constraintName)
}
