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

/**
 * A NEW service (created in the Service Catalog, no developer) gets the contract type `custom_<slug>`
 * and its wording lives in the database (service_contract_texts), approved by an owner and frozen on
 * every offer (offers.contract_texts). The rule is a plain string pattern — no lookup — so every place
 * that asks "is this a short contract?" (signing, the contract page, the MCP tool) agrees without
 * reading the database. The eight built-in types above keep their wording in code.
 */
export const CUSTOM_CONTRACT_TYPE_PATTERN = /^custom_[a-z0-9_]+$/
export type CustomContractType = `custom_${string}`
/** Every contract type that is signed on the short-contract page. */
export type ShortContractType = StandaloneAgreementType | CustomContractType

export function isCustomContractType(t: unknown): t is CustomContractType {
  return typeof t === 'string' && CUSTOM_CONTRACT_TYPE_PATTERN.test(t)
}

/**
 * The contract type a service keeps when its page is saved. A service with its OWN contract (custom_<service>, set by the
 * Contract card) keeps it whatever the page sent — a page opened before the contract existed, or an edit of the box,
 * must not unlink the stored contract. Anything else takes what the page sent.
 */
export function contractTypeToKeep(stored: string | null | undefined, requested: string | null | undefined): string | null {
  if (isCustomContractType(stored)) return stored
  const r = (requested ?? '').trim()
  return r || null
}

/**
 * A "custom_*" contract type is only ever set by the Contract card (from the service's short name). When a service page
 * is saved with one that is not the service's own stored one — typed by hand into the box — it is refused, so two
 * services can never end up sharing a contract. Null when fine.
 */
export function typedCustomContractTypeProblem(stored: string | null | undefined, requested: string | null | undefined): string | null {
  const r = (requested ?? '').trim()
  if (!isCustomContractType(r)) return null
  if (r === (stored ?? '').trim()) return null
  return 'Contract types that start with "custom_" are created by the Contract card, not typed. Clear the Contract type box and save; then create the contract in the Contract card.'
}

/** The contract type a new service gets, from its catalog slug (lowercase letters, digits, underscores). */
export function customContractTypeForSlug(slug: string): CustomContractType | null {
  const clean = String(slug ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return clean ? (`custom_${clean}` as CustomContractType) : null
}

export function isStandaloneAgreementType(t: unknown): t is ShortContractType {
  if (isCustomContractType(t)) return true
  return typeof t === 'string' && (STANDALONE_AGREEMENT_TYPES as readonly string[]).includes(t)
}

/** True for the eight built-in types whose wording is in code. */
export function isBuiltInAgreementType(t: unknown): t is StandaloneAgreementType {
  return typeof t === 'string' && (STANDALONE_AGREEMENT_TYPES as readonly string[]).includes(t)
}
