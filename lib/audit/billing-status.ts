/**
 * Billing section status computation — Phase 1 Billing Audit.
 *
 * Pure logic: no DB calls, no side effects (imports only the pure, DB-free
 * payment classifier). Takes already-fetched data (from
 * /api/clients/audit/[id]/data) and
 * computes per-check status for the billing section of the audit panel.
 *
 * Checks (per contract year):
 *   1. Annual agreement signed
 *   2. Installment 1 (Jan) invoiced
 *   3. Installment 1 (Jan) paid
 *   4. Installment 2 (Jun) invoiced
 *   5. Installment 2 (Jun) paid
 *   6. installment_2_amount configured on account
 *
 * Status values:
 *   ok           — check passes
 *   missing      — expected but absent (data gap / action needed)
 *   not_yet_due  — not expected yet based on current month
 *   na           — not applicable for this account type
 */

import { isFirstInstallment, isSecondInstallment } from '@/lib/billing/payment-classification'

export type BillingCheckStatus = 'ok' | 'missing' | 'not_yet_due' | 'na'

export type BillingCheck = {
  key: string
  label: string
  status: BillingCheckStatus
  context: string
  /** Amount in dollars when relevant (installment invoices). */
  amount?: number | null
  invoiceNumber?: string | null
  /** Payment id — set when the check refers to a specific invoice; UI wraps the
   *  invoice number in the context with an anchor to /api/invoices/<id>/pdf. */
  paymentId?: string | null
}

export type BillingStatusResult = {
  checks: BillingCheck[]
  /** True when at least one check is 'missing' — drives the section badge. */
  hasGap: boolean
  /** True when the entire billing section is N/A (not a managed Client). */
  isNA: boolean
}

// Minimal shapes — compatible with the full DB row types used in audit-panel.tsx

export type BillingPaymentRow = {
  id?: string
  installment: string | null
  description: string | null
  /** Structured billing category — the ONLY classification signal used. */
  payment_category: string | null
  /** Billing year — the ONLY year signal used (never parsed from description). */
  year: number | null
  status?: string | null
  amount: number | string | null
  amount_currency: string | null
  invoice_number: string | null
  invoice_status: string | null
  paid_date: string | null
}

export type BillingAgreementRow = {
  agreement_year: number
  status: string
}

export type BillingAccountInput = {
  account_type: string | null
  onboarding_date: string | null
  installment_2_amount: number | null
  installment_2_currency: string | null
}

/**
 * Compute billing check statuses for the given account and year.
 *
 * @param account          Minimal account fields.
 * @param payments         Non-test payments for this account (already filtered by the data route).
 * @param annualAgreements All annual_agreements rows for this account.
 * @param year             The contract year being audited (e.g. 2026).
 * @param month            Current calendar month, 1–12.
 */
export function computeBillingStatus(
  account: BillingAccountInput,
  payments: BillingPaymentRow[],
  annualAgreements: BillingAgreementRow[],
  year: number,
  month: number,
): BillingStatusResult {
  const isClient = account.account_type === 'Client'
  const hasStarted = !!account.onboarding_date

  // Non-Client accounts do not receive annual installment billing.
  if (!isClient) {
    const reason =
      account.account_type === 'One-Time' ? 'One-Time account' :
      account.account_type === 'Partner'  ? 'Partner account'  :
      `${account.account_type ?? 'Unknown'} account`
    return {
      checks: [{ key: 'billing', label: 'Annual Billing', status: 'na', context: reason }],
      hasGap: false,
      isNA: true,
    }
  }

  // Client with no onboarding date — services not yet started.
  if (!hasStarted) {
    return {
      checks: [{
        key: 'billing', label: 'Annual Billing', status: 'na',
        context: 'No onboarding date — services not yet started',
      }],
      hasGap: false,
      isNA: true,
    }
  }

  // Find signed/completed agreement for this year.
  const agreement = annualAgreements.find(
    a => a.agreement_year === year && (a.status === 'signed' || a.status === 'completed'),
  )
  // Any agreement row (including draft) — for context when not signed.
  const agreementAny = annualAgreements.find(a => a.agreement_year === year)

  // Match installment payments by the structured category + year stamp — never
  // by the installment label or the free-text description.
  const inst1 = payments.find(p => isFirstInstallment(p, year))
  const inst2 = payments.find(p => isSecondInstallment(p, year))

  const beforeJune = month < 6

  const checks: BillingCheck[] = []

  // ── Check 1: Agreement signed ────────────────────────────────────────────
  checks.push({
    key: 'agreement_signed',
    label: `${year} agreement signed`,
    status: agreement    ? 'ok'      :
            agreementAny ? 'missing' :
            'missing',
    context: agreement    ? `Signed ${year}` :
             agreementAny ? `Exists but status: ${agreementAny.status}` :
             `No agreement for ${year}`,
  })

  // ── Check 2: Installment 1 invoiced ─────────────────────────────────────
  checks.push({
    key: 'inst1_invoiced',
    label: 'Inst 1 invoiced (Jan)',
    status: inst1     ? 'ok'      :
            agreement ? 'missing' :
            'na',
    context: inst1     ? `${inst1.invoice_number ?? '—'} · $${Number(inst1.amount ?? 0).toFixed(0)}` :
             agreement ? 'Agreement signed — no Installment 1 invoice found' :
             'No signed agreement',
    amount: inst1 ? Number(inst1.amount ?? 0) : null,
    invoiceNumber: inst1?.invoice_number ?? null,
    paymentId: inst1?.id ?? null,
  })

  // ── Check 3: Installment 1 paid ──────────────────────────────────────────
  checks.push({
    key: 'inst1_paid',
    label: 'Inst 1 paid (Jan)',
    status: inst1?.invoice_status === 'Paid' ? 'ok'      :
            inst1                            ? 'missing' :
            agreement                        ? 'missing' :
            'na',
    context: inst1?.invoice_status === 'Paid'
      ? `Paid${inst1.paid_date ? ` ${inst1.paid_date.slice(0, 10)}` : ''}`
      : inst1
        ? `Status: ${inst1.invoice_status ?? '?'} — ${inst1.invoice_number ?? '—'}`
        : agreement
          ? 'No invoice'
          : 'No signed agreement',
    invoiceNumber: inst1?.invoice_number ?? null,
    paymentId: inst1?.id ?? null,
  })

  // ── Check 4: Installment 2 invoiced (Jun) ────────────────────────────────
  checks.push({
    key: 'inst2_invoiced',
    label: 'Inst 2 invoiced (Jun)',
    status: inst2      ? 'ok'          :
            !agreement ? 'na'          :
            beforeJune ? 'not_yet_due' :
            'missing',
    context: inst2
      ? `${inst2.invoice_number ?? '—'} · $${Number(inst2.amount ?? 0).toFixed(0)}`
      : !agreement
        ? 'No signed agreement'
        : beforeJune
          ? `Due in June ${year}`
          : 'June passed — no Installment 2 invoice found',
    amount: inst2 ? Number(inst2.amount ?? 0) : null,
    invoiceNumber: inst2?.invoice_number ?? null,
    paymentId: inst2?.id ?? null,
  })

  // ── Check 5: Installment 2 paid ──────────────────────────────────────────
  checks.push({
    key: 'inst2_paid',
    label: 'Inst 2 paid (Jun)',
    status: !agreement                       ? 'na'          :
            beforeJune && !inst2             ? 'not_yet_due' :
            inst2?.invoice_status === 'Paid' ? 'ok'          :
            'missing',
    context: inst2?.invoice_status === 'Paid'
      ? `Paid${inst2.paid_date ? ` ${inst2.paid_date.slice(0, 10)}` : ''}`
      : !agreement
        ? 'No signed agreement'
        : beforeJune && !inst2
          ? `Due in June ${year}`
          : inst2
            ? `Status: ${inst2.invoice_status ?? '?'} — ${inst2.invoice_number ?? '—'}`
            : 'No invoice',
    invoiceNumber: inst2?.invoice_number ?? null,
    paymentId: inst2?.id ?? null,
  })

  // ── Check 6: installment_2_amount configured ─────────────────────────────
  const inst2Amt = account.installment_2_amount
  const inst2Currency = account.installment_2_currency ?? 'USD'
  checks.push({
    key: 'inst2_amount',
    label: 'Inst 2 amount set',
    status: inst2Amt && inst2Amt > 0 ? 'ok' : 'missing',
    context: inst2Amt && inst2Amt > 0
      ? `$${inst2Amt} ${inst2Currency} configured`
      : 'Not set — cron falls back to $1,000 (SMLLC) / $1,250 (MMLLC)',
    amount: inst2Amt ?? null,
  })

  const hasGap = checks.some(c => c.status === 'missing')

  return { checks, hasGap, isNA: false }
}
