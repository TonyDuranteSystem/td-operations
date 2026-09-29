/**
 * The "Annual Maintenance" sentence printed in the client contracts (formation
 * MSA + onboarding agreement), and the same schedule as rows for the offer
 * page's "Annual Costs" box (buildAnnualCostRows).
 *
 * It used to print the offer's recurring rows verbatim under "from next year",
 * e.g. "$1000 -- First Installment (January): $1000 -- Second Installment (June):
 * $1000 -- Annual Total: $2,000" — the first "$1000" read as the yearly fee and
 * the total read as a third instalment. And it never applied the rule billing
 * already follows (getInstallmentSchedule + the DB trigger
 * trg_formation_date_installment_rule): a client who signs after September 1
 * SKIPS the next January — the setup fee covers the rest of the year. A client
 * (Stefano Stella, 2026-09-28) was told "first payment June 2027" while the
 * contract said January 2027.
 *
 * This builds the dated schedule from the same rule. Returns null when the
 * offer's rows are not a recognisable January + June pair, so the caller keeps
 * its old verbatim rendering for unusual offers.
 */
import { getInstallmentSchedule } from "@/lib/mcp/formation-date-rule"

type RecurringRow = { label?: string | null; price?: string | null; amount?: string | null; currency?: string | null }

export interface AnnualMaintenanceWording {
  /** One line per payment period, in order. */
  lines: string[]
  /** The same lines joined into one sentence. */
  sentence: string
}

function rowAmount(row: RecurringRow): number | null {
  const raw = String(row.amount ?? row.price ?? "").replace(/[^0-9.,]/g, "").replace(/,/g, "")
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

function rowSymbol(row: RecurringRow, fallbackCurrency: string | null | undefined): string {
  const cur = (row.currency || fallbackCurrency || "").toUpperCase()
  if (cur === "EUR") return "€"
  if (cur === "USD") return "$"
  const raw = String(row.amount ?? row.price ?? "")
  if (raw.includes("€") || /eur/i.test(raw)) return "€"
  return "$"
}

/** Local calendar date as YYYY-MM-DDT12:00 (noon avoids any UTC day shift). */
function noonIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T12:00:00`
}

type Leg = { amount: number; symbol: string }

/** January + June amounts from the offer's recurring rows (totals ignored), or null. */
function readJanJun(recurringCosts: unknown, currency?: string | null): { jan: Leg; jun: Leg } | null {
  const rows = Array.isArray(recurringCosts) ? (recurringCosts as RecurringRow[]) : []
  let jan: Leg | null = null
  let jun: Leg | null = null
  for (const row of rows) {
    const label = String(row?.label ?? "").toLowerCase()
    if (label.includes("annual") || label.includes("total") || label.includes("annuale")) continue
    const amount = rowAmount(row)
    if (amount == null) continue
    const symbol = rowSymbol(row, currency)
    if (!jan && (label.includes("jan") || label.includes("genn"))) jan = { amount, symbol }
    else if (!jun && (label.includes("jun") || label.includes("giugno"))) jun = { amount, symbol }
  }
  return jan && jun ? { jan, jun } : null
}

const money = (x: Leg) => `${x.symbol}${x.amount.toLocaleString("en-US")}`

export function buildAnnualMaintenanceWording(p: {
  recurringCosts: unknown
  /** offer.installment_currency, else the setup currency. */
  currency?: string | null
  /** The day the client signs (the contract's effective date). */
  signDate: Date
}): AnnualMaintenanceWording | null {
  const legs = readJanJun(p.recurringCosts, p.currency)
  if (!legs) return null
  const { jan, jun } = legs
  const total = jan.symbol === jun.symbol ? `${jan.symbol}${(jan.amount + jun.amount).toLocaleString("en-US")}` : null
  const both = (year: number) =>
    `From ${year}: ${money(jan)} in January and ${money(jun)} in June${total ? ` (${total} per year)` : ""}`

  const schedule = getInstallmentSchedule(noonIso(p.signDate))
  const lines = schedule.skipFirstJanuary
    ? [`June ${schedule.firstJuneYear}: ${money(jun)}`, both(schedule.firstJanuaryYear as number)]
    : [both(schedule.firstJuneYear)]
  return { lines, sentence: lines.join(". ") + "." }
}

export interface AnnualCostRow {
  label: string
  price: string
}

const ROW_TEXT = {
  en: {
    first: (y: number) => `First payment — June ${y}`,
    jan: (y: number) => `From ${y} — January`,
    jun: (y: number) => `From ${y} — June`,
    total: (y: number) => `Annual total (from ${y})`,
  },
  it: {
    first: (y: number) => `Prima rata — giugno ${y}`,
    jan: (y: number) => `Dal ${y} — gennaio`,
    jun: (y: number) => `Dal ${y} — giugno`,
    total: (y: number) => `Totale annuo (dal ${y})`,
  },
} as const

/**
 * The same schedule as rows for the offer page's "Annual Costs" box, in the
 * offer's language, dated from the day the client views the offer (= the day
 * they sign). Null → the caller keeps the offer's own rows.
 */
export function buildAnnualCostRows(p: {
  recurringCosts: unknown
  currency?: string | null
  viewDate: Date
  language: "en" | "it"
}): AnnualCostRow[] | null {
  const legs = readJanJun(p.recurringCosts, p.currency)
  if (!legs) return null
  const { jan, jun } = legs
  const t = ROW_TEXT[p.language] ?? ROW_TEXT.en
  const schedule = getInstallmentSchedule(noonIso(p.viewDate))
  const fullYear = schedule.skipFirstJanuary ? (schedule.firstJanuaryYear as number) : schedule.firstJuneYear
  const rows: AnnualCostRow[] = []
  if (schedule.skipFirstJanuary) rows.push({ label: t.first(schedule.firstJuneYear), price: money(jun) })
  rows.push({ label: t.jan(fullYear), price: money(jan) }, { label: t.jun(fullYear), price: money(jun) })
  if (jan.symbol === jun.symbol) rows.push({ label: t.total(fullYear), price: `${jan.symbol}${(jan.amount + jun.amount).toLocaleString("en-US")}` })
  return rows
}

/**
 * An offer that sells a service which carries a yearly fee (the service
 * catalog's has_annual — today Company Formation and Client Onboarding) must
 * state that fee: January + June. Without it the offer page has no "Annual
 * Costs" box and the contract has no yearly schedule — the client would sign
 * with no yearly fee written anywhere. Two offers in a row (Emiliano Micheli,
 * 2026-09-29) were saved that way because the builder let the boxes stay empty.
 *
 * Keyed on the SERVICES sold, not on contract_type: an add-on sold alone
 * (Change Name, Banking Setup, Closure) can carry contract_type "formation"
 * as a fallback, and must not be refused for lacking a yearly fee.
 *
 * Multi-option offers are skipped: each option carries its own renewal amounts,
 * already required when the offer is created.
 *
 * Returns the reason to refuse, or null when the offer is fine.
 */
export function yearlyFeeMissingReason(p: {
  /** The offer's services (each with pipeline_type). */
  services: unknown
  /** Pipelines of the catalog services that carry a yearly fee (has_annual). */
  annualPipelines: string[]
  recurringCosts: unknown
  packages?: unknown
  currency?: string | null
}): string | null {
  const wanted = new Set(p.annualPipelines.map((x) => x.toLowerCase()))
  const services = Array.isArray(p.services) ? (p.services as Array<{ pipeline_type?: unknown }>) : []
  const sellsAnnual = services.some((s) => wanted.has(String(s?.pipeline_type ?? "").toLowerCase()))
  if (!sellsAnnual) return null
  if (Array.isArray(p.packages) && p.packages.length >= 2) return null
  if (readJanJun(p.recurringCosts, p.currency)) return null
  return "This offer has no yearly fee. Enter the January and June amounts (Annual Rates) before sending — otherwise the offer and the contract show no yearly fee."
}
