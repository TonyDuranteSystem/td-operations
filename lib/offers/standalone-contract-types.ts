/**
 * Contract types that have their own short standalone agreement
 * (app/offer/[token]/contract/standalone-service-agreement.tsx).
 *
 * One list for every place that has to agree on it: which component signs the
 * contract (signKindFor), which agreement the contract page renders when the
 * offer IS that type, and which service lines are rendered as an inline add-on
 * agreement when the offer is a formation / onboarding that also sells them.
 * Before this list the add-on path knew only itin + tax_return, so a service
 * line typed 'closure' or 'company_change_name' inside a formation offer was
 * filtered out of the main contract and rendered nowhere — it silently
 * vanished from what the client signed.
 *
 * Adding a type = add it here + its SERVICE_CONTENT block + set the catalog
 * row's contract_type. Nothing else needs a branch.
 */
export const STANDALONE_AGREEMENT_TYPES = [
  'tax_return',
  'itin',
  'closure',
  'company_change_name',
  'ein_change_name',
  'shipping',
  'public_notary',
  'consulting_call',
] as const

export type StandaloneAgreementType = (typeof STANDALONE_AGREEMENT_TYPES)[number]

export function isStandaloneAgreementType(t: unknown): t is StandaloneAgreementType {
  return typeof t === 'string' && (STANDALONE_AGREEMENT_TYPES as readonly string[]).includes(t)
}
