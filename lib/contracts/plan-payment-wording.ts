/**
 * What a SERVICE AGREEMENT says about payment when the client agreed to pay in parts (dev job 0f4941a2, found by the 19 Nov 2026
 * production QA; child of 0a60f416).
 *
 * Section 5 of every service agreement used to say "payable in full before the work begins" even when the offer carried a payment
 * plan (a setup fee in parts, the first billed at signing). The formation / onboarding contract already states the plan in its Key
 * Terms (app/offer/[token]/contract/page.tsx, `planFeeWording`); the service agreements never did. This is the one place that decides
 * the wording for them, so the short agreements and the add-on agreements inside the long contract cannot drift apart.
 *
 * RULES (all from lib/offers/payment-plan.ts and Master Rules v3.7 P14):
 *  - the words are the sanctioned ones: `clientFacingSchedule` ("Part 1 of 2, due on signing"), introduced by "Partial Payment".
 *    Never "instalment" — that word belongs to the annual renewal contract. English only.
 *  - the plan is shown only when it is USABLE: it validates, has two or more parts, and agrees with its offer (same total, same
 *    currency — `computeOfferPayable().planRefusal` is null). When it does not, signing bills the whole fee, so "payable in full"
 *    is true and the old sentence stays.
 *  - an agreement's fee is ONE service line, while the plan covers the WHOLE offer. When the two differ the sentence says so —
 *    it never prints a part amount under a fee it does not belong to.
 *
 * Pure: no database, safe in the browser (the contract pages are client components).
 */
import { computeOfferPayable, parsePriceQuirk, resolveOfferCurrency } from '@/lib/offers/compute-offer-totals'
import { PLAN_TOTAL_TOLERANCE, clientFacingSchedule, planTotal, signingPart, validatePaymentPlan } from '@/lib/offers/payment-plan'

export interface PlanPaymentWording {
  /** The schedule as one run of text, e.g. "€250 — Part 1 of 2, due on signing; €250 — Part 2 of 2, due by 27 November 2026". */
  lines: string
  /** The whole offer's total, formatted the way the contract formats money, e.g. "€500". */
  total: string
  /** The same total as a number. */
  totalAmount: number
  /** The NUMBER of the part due at signing (work begins once it is paid; usually 1), or null when every part is raised later by hand. */
  signingSeq: number | null
}

/** The offer fields the plan wording reads. The public offer view carries all of them. */
type OfferLike = Record<string, unknown>

/**
 * The plan wording for this offer, or null when there is nothing to say (no plan, a one-part plan, an invalid plan, or a plan that
 * disagrees with its offer) — in which case the agreement keeps its ordinary "payable in full" sentence.
 */
export function planPaymentWordingFor(offer: OfferLike | null | undefined): PlanPaymentWording | null {
  if (!offer) return null
  const raw = offer.payment_plan
  if (raw == null) return null

  const payable = computeOfferPayable(
    {
      services: offer.services,
      cost_summary: offer.cost_summary,
      selected_services: offer.selected_services,
      currency: offer.currency as string | null | undefined,
      credit_amount: offer.credit_amount as number | string | null | undefined,
      payment_plan: raw,
    },
    // The SAME currency resolution signing bills with (computeOfferTotals: the offer's own currency, else the cost-summary header), so the
    // agreement never states a schedule that billing would ignore, or the other way round.
    { currencyOverride: resolveOfferCurrency(offer.currency as string | null | undefined, offer.cost_summary) },
  )
  if (payable.planRefusal) return null

  const parsed = validatePaymentPlan(raw)
  if (!parsed.ok || !parsed.plan || parsed.plan.length < 2) return null

  const symbol = payable.currency === 'USD' ? '$' : '€'
  const money = (n: number) => `${symbol}${n.toLocaleString('en-US', { minimumFractionDigits: 0 })}`
  const lines = clientFacingSchedule(parsed.plan)
    .map((r) => `${money(r.amount)} — ${r.label}`)
    .join('; ')
  const totalAmount = planTotal(parsed.plan)
  return { lines, total: money(totalAmount), totalAmount, signingSeq: signingPart(parsed.plan)?.seq ?? null }
}

/** Is this agreement's fee the WHOLE offer (so the plan's amounts are its own), rather than one line of several? */
export function feeIsWholeOffer(fee: string | null | undefined, wording: PlanPaymentWording): boolean {
  const f = parsePriceQuirk(fee)
  return Number.isFinite(f) && f > 0 && Math.abs(f - wording.totalAmount) <= PLAN_TOTAL_TOLERANCE
}
