/**
 * findTaxReturnService — Shared helper for identifying the Tax Return
 * service entry in an offer's services[] JSONB array.
 *
 * Used by BOTH:
 *   - confirm-payment preflight (app/api/crm/admin-actions/confirm-payment/route.ts)
 *   - activate-service hasBusinessContextPipeline (app/api/workflows/activate-service/route.ts)
 *
 * Matching criteria (OR — any match counts):
 *   1. pipeline_type === 'Tax Return'
 *   2. contract_type === 'tax_return'
 *   3. name contains 'tax return' (case-insensitive)
 *
 * Safety rule:
 *   - 0 matches → not_found
 *   - 1 match  → found (caller reads service_context)
 *   - 2+ matches → multiple_matches (caller blocks)
 */

export type TaxReturnServiceResult =
  | { status: 'not_found' }
  | { status: 'found'; entry: Record<string, unknown>; service_context: string | null }
  | { status: 'multiple_matches'; count: number }

export function findTaxReturnService(
  services: Array<Record<string, unknown>> | null | undefined,
): TaxReturnServiceResult {
  if (!services || !Array.isArray(services) || services.length === 0) {
    return { status: 'not_found' }
  }

  const matches = services.filter(s => {
    if (s.pipeline_type === 'Tax Return') return true
    if (s.contract_type === 'tax_return') return true
    const name = typeof s.name === 'string' ? s.name : ''
    if (name.toLowerCase().includes('tax return')) return true
    return false
  })

  if (matches.length === 0) {
    return { status: 'not_found' }
  }

  if (matches.length > 1) {
    return { status: 'multiple_matches', count: matches.length }
  }

  const entry = matches[0]
  const ctx = typeof entry.service_context === 'string' ? entry.service_context : null

  return { status: 'found', entry, service_context: ctx }
}
