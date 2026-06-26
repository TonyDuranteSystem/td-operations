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

/** Parse the `accounts.partner_deal` jsonb back into a typed PartnerDeal. */
export function parsePartnerDeal(raw: unknown): PartnerDeal | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const setup = o.setup_payout == null ? null : Number(o.setup_payout)
  const renewal = o.renewal_payout == null ? null : Number(o.renewal_payout)
  return {
    setup_payout: typeof setup === "number" && Number.isFinite(setup) ? setup : null,
    renewal_payout: typeof renewal === "number" && Number.isFinite(renewal) ? renewal : null,
    currency: typeof o.currency === "string" && o.currency ? o.currency : "USD",
    offer_token: typeof o.offer_token === "string" ? o.offer_token : null,
  }
}

/**
 * Decide whether to pay a partner their recurring renewal share for an annual
 * cycle. Pays ONLY in years AFTER the formation year — the formation year's
 * compensation is the one-time setup payout (activation Step 3.6), so paying
 * renewal in the same cycle would double-pay. Pure — unit tested.
 */
export function shouldPayRenewal(input: {
  partnerDeal: PartnerDeal | null
  formationYear: number | null
  paymentYear: number
}): { pay: boolean; amount: number; reason: "ok" | "no_renewal_deal" | "unknown_formation_year" | "formation_year" } {
  const deal = input.partnerDeal
  if (!deal || !deal.renewal_payout || deal.renewal_payout <= 0) {
    return { pay: false, amount: 0, reason: "no_renewal_deal" }
  }
  if (input.formationYear == null) {
    return { pay: false, amount: 0, reason: "unknown_formation_year" }
  }
  if (input.paymentYear <= input.formationYear) {
    return { pay: false, amount: 0, reason: "formation_year" }
  }
  return { pay: true, amount: deal.renewal_payout, reason: "ok" }
}

/**
 * Split a year's renewal share across the annual installments. The partner deal
 * carries a single ANNUAL `renewal_payout`; the client pays the renewal in two
 * installments (Jan + Jun), and the partner earns a matching share PER
 * installment — each becomes requestable when its own installment is paid
 * (Antonio 2026-06-26). The split is EVEN (the deal figure is flat, independent
 * of the client's installment amounts); the last part absorbs any rounding
 * remainder so the parts always sum to the total to the cent.
 */
export function splitRenewalPayout(total: number, parts = 2): number[] {
  if (!Number.isFinite(total) || total <= 0 || parts < 1) return []
  const cents = (n: number) => Math.round(n * 100) / 100
  const each = cents(total / parts)
  const out = Array(parts).fill(each)
  out[parts - 1] = cents(total - each * (parts - 1))
  return out
}

/**
 * The partner's renewal share for a specific 1-based installment number, given
 * the year's total renewal share. Returns 0 if out of range.
 */
export function renewalShareForInstallment(total: number, installmentNumber: number, parts = 2): number {
  const split = splitRenewalPayout(total, parts)
  return split[installmentNumber - 1] ?? 0
}
