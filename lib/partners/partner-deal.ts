/**
 * Partner deal — per-sale terms for a managed-partner offer.
 *
 * A partner can sell a TD service at a custom price with a custom split, paid as
 * a setup share (one-time, at activation) plus a renewal share (recurring, each
 * year the client renews). The terms are set per sale and persisted durably on
 * the ACCOUNT (`accounts.partner_deal`, linked partner = `accounts.partner_id`)
 * so renewal payouts years later still know the amount. Payouts land in
 * `referral_payouts` (the existing partner-payout + approval rail).
 *
 * Pure helpers — unit tested.
 */

export interface PartnerDeal {
  /** One-time partner share paid at setup/activation (deal currency). */
  setup_payout: number | null
  /** Recurring partner share paid on each annual renewal (deal currency). */
  renewal_payout: number | null
  /** ISO currency code; partner payouts are USD by default (Antonio 2026-06-25). */
  currency: string
  /** The offer this deal originated from, for audit. */
  offer_token: string | null
}

function toAmount(v: number | null | undefined): number | null {
  if (v == null) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

/**
 * Build the durable partner-deal object to persist on the account at activation.
 * Returns null when there is no partner or no positive amounts to record (so we
 * never stamp an empty deal).
 */
export function buildPartnerDeal(input: {
  partnerId: string | null | undefined
  setupPayout: number | null | undefined
  renewalPayout: number | null | undefined
  currency?: string | null
  offerToken?: string | null
}): PartnerDeal | null {
  if (!input.partnerId) return null
  const setup = toAmount(input.setupPayout)
  const renewal = toAmount(input.renewalPayout)
  if (setup == null && renewal == null) return null
  return {
    setup_payout: setup,
    renewal_payout: renewal,
    currency: (input.currency || "USD").toUpperCase(),
    offer_token: input.offerToken ?? null,
  }
}

/**
 * Whether the generic referral auto-credit (activate-service Step 3.5) should
 * run for an offer. It must NOT run when the offer is driven by a managed
 * partner (`partner_id` set) — that offer is compensated through the
 * partner-payout path (Step 3.6), and running both would PAY TWICE now that
 * Step 3.5 auto-issues a credit. (This deliberately overrides the older
 * "both can run" behavior, which was harmless only while Step 3.5 just filed a
 * manual task.)
 */
export function shouldRunReferralCredit(offer: {
  referrer_name?: string | null
  partner_id?: string | null
}): boolean {
  return !!offer.referrer_name && !offer.partner_id
}
