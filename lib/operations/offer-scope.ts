/**
 * Offer subject-scoping guards.
 *
 * Sibling of `accountIdForWizardSubmission` (lib/portal/wizard-scope.ts) for the
 * OFFER side. A formation offer is for a NEW company that does not exist yet, so
 * it must NEVER carry an existing `account_id`. The CRM create-offer dialog
 * historically inferred the subject from the launch context, so an offer for an
 * existing client (e.g. one viewed from their contact/account page, which
 * defaults to their first existing company) could be stamped with that existing
 * account even though it was a brand-new company. The portal wizard already has
 * this guard; the offer path never did. dev_task 262be11c.
 *
 * Pure function — no DB access — so it is unit-testable.
 */

/**
 * The account_id an offer may keep, given its contract type. A formation offer
 * (new company) returns null regardless of what was passed; any other contract
 * type keeps the provided account id unchanged.
 *
 * Note: createOffer defaults a missing contract_type to "formation", so this
 * guard uses the SAME default — a contract-type-less offer is treated as a
 * formation and cannot carry an account.
 */
export function accountIdForOffer(
  contractType: string | null | undefined,
  accountId: string | null | undefined,
  /** The offer is formation-TYPE but sells no formation (a name change or a
   *  closure: the offer builder derives "formation" whenever no bought service
   *  carries its own contract type). Such an offer is about an EXISTING
   *  company, so it keeps its account — otherwise a Company Change Name sold
   *  from the company's page arrives at payment with no company and can't be
   *  created (workspace-only plan S1, dev job 9d34e750; the DF Commerce shape).
   *  Callers compute this with isFormationContractWithoutFormation. */
  formationNotBought = false,
): string | null {
  const effectiveType = contractType || 'formation'
  if (effectiveType === 'formation' && !formationNotBought) return null
  return accountId ?? null
}
