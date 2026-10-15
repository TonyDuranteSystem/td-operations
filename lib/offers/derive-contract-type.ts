/**
 * Which contract type a bundled multi-service offer counts as, for gating the
 * Entity Type / State of Formation / Multiple Options sections in the Create
 * Offer dialog. 'formation' and 'onboarding' each unlock sections none of the
 * other contract types need, so they must win whenever present in the
 * selection — NOT just when they happen to be the first service the staffer
 * checked.
 *
 * Bug report (dev job 3c1bb5fa, 2026-08-26): the dialog used a plain
 * first-match loop over the selection in click order. On a bundled offer
 * (Company Formation + ITIN Application), checking ITIN before Company
 * Formation silently hid Entity Type, State of Formation, AND Multiple
 * Options — all three — with no indication anything was missing. Reproduced
 * live: `{"hasEntityType":false,"hasMultipleOptions":false,"hasStateOfFormation":false}`.
 */
export function deriveContractType(selectedContractTypes: Array<string | null | undefined>): string {
  const types = selectedContractTypes.filter((t): t is string => !!t)
  if (types.includes('formation')) return 'formation'
  if (types.includes('onboarding')) return 'onboarding'
  // A Tax Return must decide the contract whenever it is sold with ITIN: in an
  // 'itin' contract a BUSINESS tax return skipped the company-info intake — the
  // outcome depended on which box staff ticked first (S1 QA, 2026-09-27).
  if (types.includes('tax_return')) return 'tax_return'
  return types[0] ?? 'formation'
}

/**
 * True when services are selected but NONE carries a catalog contract_type, so
 * deriveContractType() can only fall back to 'formation' — the client would be
 * sent the full LLC-formation agreement for a service that is not a formation.
 * That is how Company Closure (fixed 2026-09-28) and Company Change Name
 * (2026-10-15, International Automobile Authority LLC) went wrong. Used by the
 * Create Offer dialog to warn staff instead of failing silently.
 * A selection that includes Company Formation is a real formation, never flagged.
 */
export function isUntypedFormationFallback(selectedContractTypes: Array<string | null | undefined>): boolean {
  if (selectedContractTypes.length === 0) return false
  return selectedContractTypes.every((t) => !t)
}
