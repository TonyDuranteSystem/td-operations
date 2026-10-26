import { isIncludedPrice, isRecurringPrice, parsePriceQuirk } from '@/lib/offers/compute-offer-totals'

/**
 * A short-contract fee that is not a charge: "$0", "€0.00", "Included", "included in the offer",
 * "Free". Such a service still gets its agreement (it is delivered), but the agreement must not
 * say "total fee $0, payable in full, non-refundable". Uses the money engine's own price rules
 * (compute-offer-totals) so the contract and the invoice cannot disagree about what is free.
 * A recurring price ("$500/year") is never a "no charge" one-off.
 */
export function isNoChargeFee(fee: string | null | undefined): boolean {
  const f = String(fee ?? '').trim()
  if (!f || isRecurringPrice(f)) return false
  if (isIncludedPrice(f)) return true
  if (/^(free|gratis|gift|omaggio|no charge)$/i.test(f)) return true
  return /\d/.test(f) && parsePriceQuirk(f) === 0
}
