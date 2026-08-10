/**
 * Revised-offer copy list (WS-B, dev job c0a61e44) — pure and unit-tested.
 *
 * The revise-offer route inserts an EXPLICIT field list: anything not named
 * here is silently DROPPED on revision (that silent drop ate the pinned
 * card-fee rate and the pinned referrer link for months). Extracting the copy
 * decision into a pure function makes the keep/drop table enforceable by
 * tests instead of by review vigilance. When adding a NEW offers column,
 * decide its fate HERE in the same change or it vanishes on v2.
 */

import { normalizeFormationState } from "@/lib/formation/states"

/** The subset of an offers row the copy decision reads. Loosely typed on
 *  purpose — the route hands us the raw row. */
export type OriginalOfferRow = Record<string, unknown>

export interface RevisedOfferSeed {
  finalToken: string
  newVersion: number
  offerDate: string
  bankDetails: unknown
}

/**
 * Build the insert payload for the v2 draft.
 *
 * COPIED (facts of the deal that must survive a revision): identity + language,
 * commercial content (services/cost_summary/recurring/required docs/issues/
 * notes/currency), linkage (lead_id, account_id, contact_id), deal facts
 * (contract_type, entity_type, formation_state — normalized so a legacy or
 * invalid stored value can never propagate), pinned money facts
 * (card_fee_rate, referrer_name/type + referrer_contact_id), and the payment
 * plan verbatim with its triggers.
 *
 * DELIBERATELY NOT COPIED (recorded decisions, not omissions):
 *   selected_services   — the client re-selects on the new version
 *   payment_links       — regenerated at publish for the new version's totals
 *   expires_at          — a new version gets a fresh expiry
 *   view_count/viewed_at — reset by design (v2 starts unviewed)
 *   status              — always 'draft'
 *   access_code/token   — new identity for the new version
 *   partner_* + referrer_commission_* — changing partner economics on a
 *     revision needs its own reviewed pass; flagged, out of WS-B scope
 */
export function buildRevisedOfferInsert(
  original: OriginalOfferRow,
  seed: RevisedOfferSeed,
): Record<string, unknown> {
  return {
    token: seed.finalToken,
    client_name: original.client_name,
    client_email: original.client_email,
    language: original.language,
    offer_date: seed.offerDate,
    status: "draft",
    payment_type: original.payment_type,
    contract_type: original.contract_type,
    services: original.services,
    cost_summary: original.cost_summary,
    recurring_costs: original.recurring_costs,
    bundled_pipelines: original.bundled_pipelines,
    bank_details: seed.bankDetails,
    lead_id: original.lead_id,
    account_id: original.account_id,
    required_documents: original.required_documents,
    issues: original.issues,
    admin_notes: original.admin_notes,
    currency: original.currency,
    referrer_name: original.referrer_name,
    referrer_type: original.referrer_type,
    contact_id: original.contact_id ?? null,
    entity_type: original.entity_type ?? null,
    formation_state: normalizeFormationState(original.formation_state),
    card_fee_rate: (original.card_fee_rate as number | null | undefined) ?? null,
    // WS-A display scalars: a revised offer must keep showing the client's
    // already-paid credit. Display-only — if these were ever dropped the
    // client's BALANCE would still be right (the ledger holds the money), but
    // the offer would silently stop mentioning it.
    credit_amount: (original.credit_amount as number | null | undefined) ?? null,
    credit_payment_id: (original.credit_payment_id as string | null | undefined) ?? null,
    // Without this a revised offer silently drops from "Already paid — Strategy
    // Call" to the neutral "Credit applied" — a wording regression on the one
    // document the client compares side by side with the previous version.
    credit_kind: (original.credit_kind as string | null | undefined) ?? null,
    referrer_contact_id: (original.referrer_contact_id as string | null | undefined) ?? null,
    // WS-C: the payment plan is a FACT OF THE DEAL — what the client agreed to pay and when.
    // Copied VERBATIM, triggers included. Two reasons it cannot be left to regeneration:
    // dropping it would silently turn a EUR1,250 + EUR1,250 agreement back into one EUR2,500
    // bill on v2, and a trigger flattened to a plain amount loses the answer to "when is part
    // two due?" — which is the only thing the schedule and the mint action have to go on.
    payment_plan: (original.payment_plan as unknown) ?? null,
    view_count: 0,
    version: seed.newVersion,
  }
}
