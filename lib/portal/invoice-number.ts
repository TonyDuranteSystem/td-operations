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
  // LIKE's underscore matches ANY character, so a malformed row like 'INV-MMQA-3'
  // also matches and lex-sorts ABOVE every numeric INV- — taking only the first
  // row would parse NaN, hide the true numeric max, and produce a permanently
  // colliding candidate (verified against real INV-MMQA-* rows in sandbox,
  // 2026-07-08). Scan a page per table and take the highest ALL-DIGITS suffix.
  const [ciResult, pResult] = await Promise.all([
    supabaseAdmin
      .from('client_invoices')
      .select('invoice_number')
      .like('invoice_number', strictPattern)
      .order('invoice_number', { ascending: false })
      .limit(50),
    supabaseAdmin
      .from('payments')
      .select('invoice_number')
      .like('invoice_number', strictPattern)
      .order('invoice_number', { ascending: false })
      .limit(50),
  ])

  const maxSeq = Math.max(
    maxNumericSuffix((ciResult.data ?? []).map(r => r.invoice_number), prefix),
    maxNumericSuffix((pResult.data ?? []).map(r => r.invoice_number), prefix),
  )

  return `${prefix}${String(maxSeq + 1).padStart(6, '0')}`
}

/**
 * Generate next CREDIT-NOTE number.
 * Format: CN-NNNNNN (e.g., CN-000001). Separate sequence from INV- invoices so a
 * credit note never reads as an invoice. Credit notes live in `payments`.
 *
 * Same race-safety contract as generateInvoiceNumber: not race-safe alone — the
 * caller catches the unique-violation on `uq_payments_invoice_number` and retries.
 */
export async function generateCreditNoteNumber(): Promise<string> {
  const prefix = 'CN-'
  const strictPattern = `${prefix}______` // 6 underscores → exactly 6 chars after prefix
  // LIKE's underscore matches ANY character, so a malformed row like 'CN-QA0001'
  // also matches — and lex-sorts ABOVE every numeric CN- (letters > digits), so
  // trusting only the lexicographic max would parse NaN → always yield CN-000001
  // → a permanent unique-violation retry loop. Scan a page (desc) and take the
  // highest ALL-DIGITS suffix instead. Caught in sandbox QA 2026-07-08
  // (generateInvoiceNumber above had the same bug, hit by real INV-MMQA-* rows).
  const { data } = await supabaseAdmin
    .from('payments')
    .select('invoice_number')
    .like('invoice_number', strictPattern)
    .order('invoice_number', { ascending: false })
    .limit(50)

  const maxSeq = maxNumericSuffix((data ?? []).map(r => r.invoice_number), prefix)
  return `${prefix}${String(maxSeq + 1).padStart(6, '0')}`
}

/**
 * Highest 6-digit numeric suffix among `PREFIX-NNNNNN` numbers, ignoring
 * malformed entries (non-digit suffixes). Pure — unit tested.
 */
export function maxNumericSuffix(numbers: Array<string | null>, prefix: string): number {
  let max = 0
  for (const n of numbers) {
    if (!n || !n.startsWith(prefix)) continue
    const suffix = n.slice(prefix.length)
    if (!/^\d{6}$/.test(suffix)) continue
    const num = parseInt(suffix, 10)
    if (num > max) max = num
  }
  return max
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
