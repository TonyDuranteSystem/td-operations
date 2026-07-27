/**
 * Operating-agreement signature vocabularies — the values the database will accept.
 *
 * Registered with the code↔database contract gate on 2026-07-27. Both columns were added to
 * production without a code-side list, so nothing verified that what the signing page writes
 * is what the database permits — and a rejected write here is a signature that silently does
 * not record. Same shape as the incident that killed the bank-feed review queue.
 *
 * ⚠️ Adding a value here is not enough: it must also be added to the database CHECK (via a
 * migration) before any code writes it.
 */

/** How the agreement itself was executed. */
export const OA_AGREEMENT_SIGNATURE_METHODS = ["electronic", "by_hand"] as const
export type OaAgreementSignatureMethod = (typeof OA_AGREEMENT_SIGNATURE_METHODS)[number]

/** How an individual signature was captured on the signing page. */
export const OA_SIGNATURE_METHODS = ["drawn", "typed", "uploaded"] as const
export type OaSignatureMethod = (typeof OA_SIGNATURE_METHODS)[number]
