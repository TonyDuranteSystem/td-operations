import { isStandaloneAgreementType, type ShortContractType } from '@/lib/offers/standalone-contract-types'
import { isIncludedPrice, isRecurringPrice, parsePriceQuirk } from '@/lib/offers/compute-offer-totals'
import type { OfferService } from '@/lib/types/offer'

export interface AgreementEntry {
  type: ShortContractType
  line: OfferService
}

type OfferLike = { services?: unknown; selected_services?: unknown }

/** A JSONB list some legacy rows and MCP callers store as a JSON string (the pages parse both). */
function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  return []
}
const servicesOf = (o: OfferLike): OfferService[] => asArray(o.services) as OfferService[]

export interface PlanOptions {
  /**
   * true = an optional service counts as bought even when no selection is stored (used by the staff
   * warning at creation, when nothing is ticked yet). Default false = the contract page, which follows
   * BILLING: with no stored selection only the required services are bought (lib/payments/billable-selection.ts).
   */
  assumeOptionalBought?: boolean
}

/**
 * The agreements of a short-contract offer, in offer order — one per BOUGHT line.
 *
 * A line has its own agreement when it has a short-contract `contract_type`. A line with NO type
 * is, by the documented convention ("services without contract_type default to the offer's
 * contract_type"), part of the offer's own contract — but only ONE such line: the first, and only
 * when no line carries the offer's own type. Other untyped lines have no agreement (the staff
 * warning says so). A line is not bought when it is optional and was not ticked.
 */
export function selectedStandaloneAgreements(
  offer: OfferLike,
  contractType?: string | null,
  opts: PlanOptions = {},
): AgreementEntry[] {
  const services = servicesOf(offer)
  const selected = new Set(asArray(offer.selected_services).filter((x): x is string => typeof x === 'string'))
  const bought = (l: OfferService) => !l.optional || (opts.assumeOptionalBought ? selected.size === 0 || selected.has(l.name) : selected.has(l.name))
  const ownType = isStandaloneAgreementType(contractType) ? contractType : null
  const hasOwnTypedLine = ownType !== null && services.some((l) => l?.contract_type === ownType)
  const untypedMain = ownType !== null && !hasOwnTypedLine ? services.find((l) => l && !l.contract_type && bought(l)) : undefined

  const out: AgreementEntry[] = []
  for (const line of services) {
    if (!line || !bought(line)) continue
    if (isStandaloneAgreementType(line.contract_type)) out.push({ type: line.contract_type, line })
    else if (ownType !== null && line === untypedMain) out.push({ type: ownType, line })
  }
  return out
}

export interface AgreementPlan {
  /** 'multi' = several agreements in one document, one signature; 'single' = the original one-agreement page. */
  mode: 'single' | 'multi'
  /** What the page shows, in order: one entry in 'single' mode (none only when the offer has no lines). */
  entries: AgreementEntry[]
}

/**
 * What the short-contract page shows for an offer — the ONE place that decides it, used by the page
 * itself and by the warning staff get when a billed service would have no agreement, so the two can
 * never disagree.
 *
 * `multiEnabled` is the switch (app setting `short_contract_multi_agreements`). OFF = the page is
 * exactly what it always was: the line of the offer's own type, else the first line, whatever the
 * client ticked. ON = one agreement per bought line (2 or more = 'multi'); with only one it shows
 * that one — even when it is not the offer's own type because the client declined the offer's own
 * service. Nothing bought and typed = the original single page.
 */
export function planAgreements(
  offer: OfferLike,
  contractType: string,
  multiEnabled: boolean,
  opts: PlanOptions = {},
): AgreementPlan {
  const services = servicesOf(offer)
  const original = (): AgreementEntry[] => {
    const line = services.find((l) => l?.contract_type === contractType) ?? services[0]
    return line && isStandaloneAgreementType(contractType) ? [{ type: contractType, line }] : []
  }
  if (!multiEnabled) return { mode: 'single', entries: original() }

  const entries = selectedStandaloneAgreements(offer, contractType, opts)
  if (entries.length >= 2) return { mode: 'multi', entries }
  if (entries.length === 1) return { mode: 'single', entries }
  return { mode: 'single', entries: original() }
}

/** A line the client pays for: a real one-off price — the money engine's own rules, so invoice and contract agree. */
function isBilledLine(line: OfferService): boolean {
  const price = line?.price
  if (price == null || String(price).trim() === '') return false
  return !isRecurringPrice(price) && !isIncludedPrice(price) && parsePriceQuirk(price) > 0
}

export interface CoverageGap {
  /** Billed lines that have their own short agreement but will not appear in the contract because the switch is OFF. */
  hiddenBySwitch: string[]
  /** Billed lines that cannot appear in the contract: no short-contract type of their own. */
  withoutContract: string[]
}

/**
 * Billed services of a short-contract offer that the client's contract would NOT contain.
 * Empty gap = every billed line is covered. Offers whose main type is not a short contract
 * (formation, onboarding, renewal) are not judged here. Optional lines are assumed bought
 * (nothing is ticked yet when the offer is created).
 */
export function agreementCoverageGap(
  offer: OfferLike,
  contractType: string | null | undefined,
  multiEnabled: boolean,
): CoverageGap {
  const gap: CoverageGap = { hiddenBySwitch: [], withoutContract: [] }
  if (!isStandaloneAgreementType(contractType)) return gap
  // Parse ONCE: a JSON-string `services` would otherwise give the plan and this loop different objects.
  const services = servicesOf(offer)
  const shown = new Set(planAgreements({ services, selected_services: offer.selected_services }, contractType, multiEnabled, { assumeOptionalBought: true }).entries.map((e) => e.line))
  for (const line of services) {
    if (!line || shown.has(line) || !isBilledLine(line)) continue
    if (!multiEnabled && isStandaloneAgreementType(line.contract_type)) gap.hiddenBySwitch.push(line.name)
    else gap.withoutContract.push(line.name)
  }
  return gap
}

const list = (names: string[]) => names.map((n) => `"${n}"`).join(', ')

/** Plain-English warnings for staff (shown when the offer is created); [] when nothing is missing. */
export function agreementCoverageWarnings(gap: CoverageGap): string[] {
  const out: string[] = []
  const h = gap.hiddenBySwitch
  if (h.length > 0) {
    out.push(
      `${list(h)} ${h.length > 1 ? 'are' : 'is'} on this offer, but the client's contract will show only the main service's agreement, because the switch "Several agreements in one contract" (Dev Tools) is OFF. To give the client a separate agreement for the extra service, sell it in its own offer.`,
    )
  }
  const w = gap.withoutContract
  if (w.length > 0) {
    out.push(
      `${list(w)} ${w.length > 1 ? 'are' : 'is'} billed but ${w.length > 1 ? 'have' : 'has'} no contract of ${w.length > 1 ? 'their' : 'its'} own, so the client will sign no agreement for ${w.length > 1 ? 'them' : 'it'}. Pick the service from the catalog (it carries its contract) or take the line off the offer.`,
    )
  }
  return out
}
