/**
 * Canonical default for an LLC annual-management installment when an account
 * has no explicit `installment_N_amount`. MMLLC = $1,250, all others = $1,000.
 *
 * Mirrors the rule already used by app/api/cron/annual-installments/route.ts
 * for the June (Installment 2) cron. Use this helper everywhere a fallback is
 * needed so the offer/transition flow and the cron flow can never disagree.
 */
export function defaultInstallmentAmount(entityType: string | null | undefined): number {
  if (!entityType) return 1000
  const upper = entityType.toUpperCase()
  if (upper.includes('MULTI') || upper.includes('MMLLC')) return 1250
  return 1000
}
