/**
 * THE offer amount engine (WS-A3, dev job c0a61e44).
 *
 * One totals-only calculator replacing ~25 duplicated parser call sites across
 * 10 files. It REPRODUCES the offer-signed webhook's historical semantics
 * exactly — quirks included — because that webhook's output IS the money of
 * record (invoice + activation amounts). Divergences in other copies (the offer
 * page's price-string currency sniffing) are documented here and unified
 * TOWARD these semantics at each site's migration.
 *
 * ACCEPTED TECHNICAL DEBT (architect R3-2, recorded in docs/systems/offers.md):
 * prices remain parsed TEXT. This module centralizes the quirks under
 * characterization tests; it does not make prices numeric.
 *
 * Pinned quirks (do NOT "fix" without an architect decision + open-offer replay):
 *  - parsePrice strips every non-[0-9.] char: minus signs vanish ("-€257" → 257),
 *    EU thousands break ("€1.500" → 1.5). Credits therefore NEVER ride as
 *    negative price lines — they live in dedicated fields (computeNet).
 *  - Service lines matching /(year|anno|month|mese)/i or /includ|inclus/i are
 *    skipped (recurring/informational).
 *  - Pre-condition groups (label /pre.?condition/i) are added from cost_summary.
 *  - When services parse to 0, the fallback reads cost_summary[0].total with
 *    EU-format handling ("1.500" → 1500 when dot-thousands and no comma).
 *  - Invoice currency = cost_summary[0] total/total_label containing '€'/EUR →
 *    EUR, else USD (the webhook variant — authoritative for money).
 */

export interface OfferLikeForTotals {
  services?: unknown
  cost_summary?: unknown
  selected_services?: unknown
  /** The currency recorded on the offer. Authoritative when present. */
  currency?: string | null
  /** Display-only credit snapshot ("already paid"). */
  credit_amount?: number | string | null
}

export interface ComputeOptions {
  /**
   * Multi-contract offers (e.g. formation + a standalone ITIN agreement) render
   * ONE agreement per contract type. When set, only service lines whose own
   * `contract_type` matches (or is absent) are counted — the contract-page
   * semantics. Omitted = count every selected line (offer-page / webhook /
   * checkout semantics: the client pays the whole offer).
   */
  filterContractType?: string
  /**
   * When the offer carries an explicit `currency` column, pass it: the contract
   * pages trust that column over header sniffing ("no symbol-sniffing" is their
   * stated rule). Omitted = header-based detection (money-of-record variant).
   */
  currencyOverride?: "EUR" | "USD" | null
  /**
   * Contract-page variant: when no stored selection exists, count all
   * non-optional lines (same as default). When a stored selection EXISTS, the
   * contract pages honour it exactly — identical to the default path, kept
   * explicit so the difference is documented rather than assumed.
   */
}

export interface OfferTotals {
  /** Sum of selected one-time service lines (webhook parser semantics). */
  servicesTotal: number
  /** Names of the service lines actually counted (checkout labels charges with them). */
  countedServiceNames: string[]
  /** Sum of pre-condition group items from cost_summary. */
  preconditionsTotal: number
  /** servicesTotal + preconditionsTotal, or the cost_summary[0] fallback when 0. */
  gross: number
  /** 'EUR' | 'USD' — the webhook (money-of-record) detection variant. */
  currency: "EUR" | "USD"
  /** Which path produced `gross`: parsed lines or the header fallback. */
  source: "lines" | "summary_fallback" | "none"
}

/** The historical parser, verbatim semantics. Exported for characterization. */
export function parsePriceQuirk(raw: unknown): number {
  const priceNum = parseFloat(String(raw ?? "0").replace(/[^0-9.]/g, ""))
  return isNaN(priceNum) ? 0 : priceNum
}

const RECURRING_RE = /\/(year|anno|month|mese)/i
const INCLUDED_RE = /includ|inclus/i
const PRECONDITION_RE = /pre.?condition/i

interface SummaryGroup {
  label?: string
  total?: string
  total_label?: string
  items?: Array<{ name?: string; price?: string }>
}

function summaryArray(cost_summary: unknown): SummaryGroup[] {
  if (Array.isArray(cost_summary)) return cost_summary as SummaryGroup[]
  if (typeof cost_summary === "string") {
    try {
      const parsed = JSON.parse(cost_summary)
      return Array.isArray(parsed) ? (parsed as SummaryGroup[]) : []
    } catch {
      return []
    }
  }
  return []
}


/**
 * THE currency rule for an offer — storage, engine and credit paths all use this
 * one (architect ruling, WS-A blocker 2).
 *
 * There used to be two. The offer's STORED currency sniffed the header AND the
 * whole services blob; the money engine sniffed the header alone. An offer with
 * "€" in a service line but not in the header was therefore stored as EUR and
 * charged as USD — so a euro credit was looked up, rendered with a dollar sign,
 * and then never deducted at signing because the invoice was in dollars.
 *
 * EXPLICIT WINS. A currency recorded on the offer is a decision someone made;
 * sniffing is only for the offers that never had one. Verified before adopting:
 * of 160 open production offers, 130 carry no currency at all and ZERO of the 30
 * that do disagree with the header — so this changes nothing already live.
 *
 * The services blob is deliberately NOT sniffed any more: a EUR offer carrying a
 * recurring "$2,000/year" line flipped it, which is the real mischarge the
 * engine's header rule was introduced to fix.
 */
export function resolveOfferCurrency(
  explicit: string | null | undefined,
  cost_summary: unknown,
): "EUR" | "USD" {
  const e = String(explicit ?? "").trim().toUpperCase()
  if (e === "EUR" || e === "USD") return e
  const summary = summaryArray(cost_summary)
  const headerRaw = String(summary[0]?.total || summary[0]?.total_label || "")
  return headerRaw.includes("€") || headerRaw.toUpperCase().includes("EUR") ? "EUR" : "USD"
}

export function computeOfferTotals(
  offer: OfferLikeForTotals,
  options: ComputeOptions = {},
): OfferTotals {
  const services = Array.isArray(offer.services) ? (offer.services as Array<Record<string, unknown>>) : []
  const selected: string[] = Array.isArray(offer.selected_services)
    ? (offer.selected_services as unknown as string[])
    : []
  const summary = summaryArray(offer.cost_summary)

  let servicesTotal = 0
  const countedServiceNames: string[] = []
  for (const svc of services) {
    const name = (svc.name as string) || ""
    const isOptional = !!svc.optional
    const isSelected = !isOptional || selected.includes(name)
    if (!isSelected) continue
    // Multi-contract filter (contract-page semantics only — see ComputeOptions).
    if (options.filterContractType) {
      const svcType = svc.contract_type as string | undefined
      if (svcType && svcType !== options.filterContractType) continue
    }
    const priceStr = String(svc.price || "0")
    if (RECURRING_RE.test(priceStr)) continue
    if (INCLUDED_RE.test(priceStr)) continue
    const n = parsePriceQuirk(priceStr)
    if (n > 0) {
      servicesTotal += n
      countedServiceNames.push(name)
    }
  }

  let preconditionsTotal = 0
  for (const group of summary) {
    if (!PRECONDITION_RE.test(group.label || "")) continue
    for (const item of group.items || []) {
      const n = parsePriceQuirk(item.price)
      if (n > 0) preconditionsTotal += n
    }
  }

  let gross = servicesTotal + preconditionsTotal
  let source: OfferTotals["source"] = gross > 0 ? "lines" : "none"

  // Historical fallback: header total with EU-format handling.
  if (gross === 0 && summary.length > 0) {
    const raw = summary[0].total || summary[0].total_label || ""
    const numStr = raw.replace(/[^0-9.,]/g, "").trim()
    if (numStr) {
      gross = /\.\d{3}$/.test(numStr) && !numStr.includes(",")
        ? parseFloat(numStr.replace(/\./g, ""))
        : parseFloat(numStr.replace(",", ""))
      if (isNaN(gross)) gross = 0
      if (gross > 0) source = "summary_fallback"
    }
  }

  // ONE rule, shared with storage and the credit path (blocker 2).
  const currency: "EUR" | "USD" =
    options.currencyOverride ?? resolveOfferCurrency(offer.currency, offer.cost_summary)

  return { servicesTotal, countedServiceNames, preconditionsTotal, gross, currency, source }
}


export interface OfferPayable {
  /** Full price of what was selected. */
  gross: number
  /** Credit already paid, applied against this offer (same currency only). */
  credit: number
  /** What the client actually owes — the ONE number every rail must use. */
  net: number
  currency: "EUR" | "USD"
  servicesTotal: number
  preconditionsTotal: number
  countedServiceNames: string[]
}

/**
 * WHAT THE CLIENT OWES — the single amount authority (Antonio's ruling: NET
 * EVERYWHERE; every payment rail charges what the invoice of record says).
 *
 * Before this, the offer page subtracted the credit in its summary while the pay
 * buttons, the bank-transfer box, the card checkout and the signed contract all
 * quoted the GROSS. A client reading "Totale Dovuto Oggi €1,243" was charged
 * €1,575 on the card — paying for the strategy call a second time — against an
 * invoice of record that said €1,243.
 *
 * No surface may compute its own idea of the amount. Card fee is applied to the
 * NET, because the fee is a percentage of what is actually being charged.
 *
 * The credit here is the offer's own snapshot. It is display-scoped by design:
 * the netting engine at invoice creation remains the money of record and applies
 * only credit that genuinely still exists. This function's job is to stop the
 * rails from contradicting the page and each other.
 */
export function computeOfferPayable(
  offer: OfferLikeForTotals,
  options: ComputeOptions = {},
): OfferPayable {
  const t = computeOfferTotals(offer, options)
  const raw = Number(offer.credit_amount ?? 0)
  const credit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.round(raw * 100) / 100, t.gross) : 0
  return {
    gross: t.gross,
    credit,
    net: Math.max(Math.round((t.gross - credit) * 100) / 100, 0),
    currency: t.currency,
    servicesTotal: t.servicesTotal,
    preconditionsTotal: t.preconditionsTotal,
    countedServiceNames: t.countedServiceNames,
  }
}

export interface AppliedCreditInput {
  amount: number
  currency: string
}

export interface NetResult {
  gross: number
  /** Credits actually applied (same-currency only — the engine's hard rule). */
  appliedCredits: number
  net: number
  /** Credits skipped because their currency differs from the offer's. */
  skippedCrossCurrency: number
}

/**
 * Net-of-credit math. SAME-CURRENCY ONLY (locked decision D3): a euro credit
 * never subtracts one-to-one from a dollar offer; cross-currency credits are
 * reported, never silently applied. Never returns a negative net.
 */
export function computeNetOfCredits(
  gross: number,
  currency: "EUR" | "USD",
  credits: AppliedCreditInput[],
): NetResult {
  let applied = 0
  let skipped = 0
  for (const c of credits) {
    const amt = Number(c.amount) || 0
    if (amt <= 0) continue
    if (c.currency === currency) applied += amt
    else skipped += amt
  }
  applied = Math.min(Math.round(applied * 100) / 100, gross)
  return {
    gross,
    appliedCredits: applied,
    net: Math.max(Math.round((gross - applied) * 100) / 100, 0),
    skippedCrossCurrency: Math.round(skipped * 100) / 100,
  }
}
