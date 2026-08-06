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
}

export interface OfferTotals {
  /** Sum of selected one-time service lines (webhook parser semantics). */
  servicesTotal: number
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

export function computeOfferTotals(offer: OfferLikeForTotals): OfferTotals {
  const services = Array.isArray(offer.services) ? (offer.services as Array<Record<string, unknown>>) : []
  const selected: string[] = Array.isArray(offer.selected_services)
    ? (offer.selected_services as unknown as string[])
    : []
  const summary = summaryArray(offer.cost_summary)

  let servicesTotal = 0
  for (const svc of services) {
    const name = (svc.name as string) || ""
    const isOptional = !!svc.optional
    const isSelected = !isOptional || selected.includes(name)
    if (!isSelected) continue
    const priceStr = String(svc.price || "0")
    if (RECURRING_RE.test(priceStr)) continue
    if (INCLUDED_RE.test(priceStr)) continue
    const n = parsePriceQuirk(priceStr)
    if (n > 0) servicesTotal += n
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

  const headerRaw = String(summary[0]?.total || summary[0]?.total_label || "")
  const currency: "EUR" | "USD" =
    headerRaw.includes("€") || headerRaw.toUpperCase().includes("EUR") ? "EUR" : "USD"

  return { servicesTotal, preconditionsTotal, gross, currency, source }
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
