/**
 * Which existing offers block a NEW offer from being created (the "active offer already exists" refusal, HTTP 409).
 *
 * Precedence is unchanged: a lead beats a company, a company beats a contact. What changed (Company Closure Part C, dev job a6bbea09):
 * a company with ANY other open offer — of any kind — used to refuse a Company Closure (or a Tax Return, an ITIN…) offer, so a
 * closure could not be offered to a company that had, say, an unsigned tax-return offer lying around. A short standalone service is
 * now blocked only by an open offer of the SAME kind, exactly as it already was for a contact. A bundle (formation, onboarding…)
 * on a company still blocks on any open offer, as before — two bundles on one company are never intended.
 *
 * Pure, so the offer builder and the tests use the same rule.
 */

import { isStandaloneAgreementType } from "@/lib/offers/standalone-contract-types"

export interface DuplicateScope {
  /** which owner column to compare, and the value */
  column: "lead_id" | "account_id" | "contact_id"
  value: string
  /** when set, only open offers of this contract type block */
  contractType?: string
}

export function duplicateOfferScope(p: {
  leadId?: string | null
  accountId?: string | null
  contactId?: string | null
  contractType?: string | null
}): DuplicateScope | null {
  if (p.leadId) return { column: "lead_id", value: p.leadId }
  if (p.accountId) {
    return isStandaloneAgreementType(p.contractType)
      ? { column: "account_id", value: p.accountId, contractType: p.contractType as string }
      : { column: "account_id", value: p.accountId }
  }
  if (p.contactId) return p.contractType ? { column: "contact_id", value: p.contactId, contractType: p.contractType } : { column: "contact_id", value: p.contactId }
  return null
}
