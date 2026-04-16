/**
 * P1.7 — Invoice-creation policy at offer-signed time.
 *
 * Single predicate extracted from `app/api/webhooks/offer-signed/route.ts`
 * so P1.7 flow 3 (new contract → invoice) and flow 4 (renewal → no
 * invoice) can be covered by a focused characterization test.
 *
 * The rule, stated in one place:
 *
 *   Create a TD invoice at offer signing time when ALL hold:
 *     - A contact is resolved (contactId is non-null)
 *     - The signed offer has a positive total amount
 *     - contract_type is NOT "renewal" — renewals are invoiced later on
 *       the renewal cycle, not at signing
 *
 * Moving this to a lib file lets both the webhook and the test import
 * the same function, so any policy change is caught in one place.
 */

export interface InvoiceAtSigningParams {
  contract_type: string | null | undefined
  contact_id: string | null | undefined
  total_amount: number | null | undefined
}

export type InvoiceAtSigningSkipReason =
  | "no_contact"
  | "zero_amount"
  | "renewal"
  | null

export interface InvoiceAtSigningDecision {
  create: boolean
  /** When create=false, identifies the skip reason. Null when create=true. */
  reason: InvoiceAtSigningSkipReason
}

export function decideInvoiceAtSigning(
  params: InvoiceAtSigningParams,
): InvoiceAtSigningDecision {
  if (!params.contact_id) return { create: false, reason: "no_contact" }
  if (!params.total_amount || params.total_amount <= 0) {
    return { create: false, reason: "zero_amount" }
  }
  if ((params.contract_type ?? "") === "renewal") {
    return { create: false, reason: "renewal" }
  }
  return { create: true, reason: null }
}

/** Contract types that map to a signed-invoice at offer time. Mirrors
 *  the `serviceLabel` switch in offer-signed/route.ts; exported here so
 *  tests can assert label mapping alongside the policy decision. */
export const NEW_CONTRACT_TYPES = [
  "formation",
  "onboarding",
  "tax_return",
  "itin",
] as const

export type NewContractType = (typeof NEW_CONTRACT_TYPES)[number]

export function getServiceLabel(contract_type: string | null | undefined): string {
  switch (contract_type) {
    case "formation":
      return "LLC Formation"
    case "onboarding":
      return "LLC Onboarding"
    case "tax_return":
      return "Tax Return"
    case "itin":
      return "ITIN Application"
    default:
      return "Service"
  }
}
