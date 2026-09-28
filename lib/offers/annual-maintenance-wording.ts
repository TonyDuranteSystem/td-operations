/**
 * The "Annual Maintenance" sentence printed in the client contracts (formation
 * MSA + onboarding agreement).
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

export function buildAnnualMaintenanceWording(p: {
  recurringCosts: unknown
  /** offer.installment_currency, else the setup currency. */
  currency?: string | null
  /** The day the client signs (the contract's effective date). */
  signDate: Date
}): AnnualMaintenanceWording | null {
  const rows = Array.isArray(p.recurringCosts) ? (p.recurringCosts as RecurringRow[]) : []
  let jan: { amount: number; symbol: string } | null = null
  let jun: { amount: number; symbol: string } | null = null
  for (const row of rows) {
    const label = String(row?.label ?? "").toLowerCase()
    if (label.includes("annual") || label.includes("total") || label.includes("annuale")) continue
    const amount = rowAmount(row)
    if (amount == null) continue
    const symbol = rowSymbol(row, p.currency)
    if (!jan && (label.includes("jan") || label.includes("genn"))) jan = { amount, symbol }
    else if (!jun && (label.includes("jun") || label.includes("giugno"))) jun = { amount, symbol }
  }
  if (!jan || !jun) return null

  const money = (x: { amount: number; symbol: string }) => `${x.symbol}${x.amount.toLocaleString("en-US")}`
  const total = jan.symbol === jun.symbol ? `${jan.symbol}${(jan.amount + jun.amount).toLocaleString("en-US")}` : null
  const both = (year: number) =>
    `From ${year}: ${money(jan!)} in January and ${money(jun!)} in June${total ? ` (${total} per year)` : ""}`

  const schedule = getInstallmentSchedule(noonIso(p.signDate))
  const lines = schedule.skipFirstJanuary
    ? [`June ${schedule.firstJuneYear}: ${money(jun)}`, both(schedule.firstJanuaryYear as number)]
    : [both(schedule.firstJuneYear)]
  return { lines, sentence: lines.join(". ") + "." }
}
