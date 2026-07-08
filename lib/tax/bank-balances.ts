/**
 * Per-bank balance anchors (S2 slice 2, 2026-07-08 — tri-role approved).
 *
 * The client (or staff) records each bank account's opening + closing balance
 * for the tax year — the two numbers on every statement header, and the
 * anchors that turn "the client hand-reconciles our numbers" (the Dynamiq
 * week) into an automatic per-bank gate:
 *
 *     opening + net movement = closing        (else: name the bank + the hole)
 *
 * CPA conditions built in:
 *  - Balances live in the account's OWN currency; conversion to USD (IRS
 *    yearly-average) happens only for the consolidated sheet/tie math.
 *  - SYSTEM-derived figures (statement balance columns) OUTRANK typed ones;
 *    when both exist and disagree beyond tolerance, that clash is itself a
 *    finding — never silently prefer either.
 *  - Every figure carries provenance ('statements' | 'client' | 'staff') so
 *    the UI can say "per client-provided balances", never implying bank-
 *    verified when it isn't.
 *
 * Pure module: no DB. Callers load `account_bank_balances` rows and the
 * engine's per-bank positions, and feed them here.
 */

import { toUsd, type FxRates } from "./fx"

export interface ProvidedBankBalance {
  bank_key: string
  currency: string
  opening_balance: number | null
  closing_balance: number | null
  source: "client" | "staff"
}

export interface BankPositionInput {
  bank_key: string
  /** From statement balance columns (already USD). Null when no balance column. */
  derived_beginning: number | null
  reported_ending: number | null
  /** USD-converted sum of the bank's transactions. */
  net_movement: number
}

export type TieStatus = "ok" | "mismatch" | "unverifiable"

export interface BankBalanceMerge {
  bank_key: string
  /** USD opening used for consolidation: statements-derived first, else provided (converted). */
  opening_usd: number | null
  opening_source: "statements" | "client" | "staff" | null
  /** USD closing anchor: statements-reported first, else provided (converted). */
  closing_usd: number | null
  closing_source: "statements" | "client" | "staff" | null
  /** opening + net_movement, when an opening exists. */
  expected_closing_usd: number | null
  /** expected − anchor closing; null when unverifiable. */
  delta_usd: number | null
  tie: TieStatus
  /** Derived vs provided disagree beyond tolerance (both existed) — a finding. */
  provided_conflicts_derived: boolean
  /** Provided balance in a currency with no IRS rate on file — excluded from totals. */
  missing_fx_rate: boolean
}

export interface BankBalancesSummary {
  banks: BankBalanceMerge[]
  /** Sum of per-bank USD openings — null unless EVERY bank has one. */
  total_opening_usd: number | null
  /** 'statements' when every opening came from balance columns; 'provided'
   * when at least one typed balance fills a gap (label: "per client-provided
   * balances"); null when incomplete. */
  total_opening_source: "statements" | "provided" | null
  /** bank_keys still missing an opening — the UI asks for exactly these. */
  missing_openings: string[]
  mismatched_banks: string[]
}

export const BALANCE_TIE_TOLERANCE_USD = 0.02

export function mergeBankBalances(input: {
  banks: BankPositionInput[]
  provided: ProvidedBankBalance[]
  fxRates: FxRates | null
  toleranceUsd?: number
}): BankBalancesSummary {
  const { banks, provided, fxRates } = input
  const tolerance = input.toleranceUsd ?? BALANCE_TIE_TOLERANCE_USD
  const byKey = new Map(provided.map(p => [p.bank_key, p]))

  const merged: BankBalanceMerge[] = banks.map(b => {
    const p = byKey.get(b.bank_key) ?? null
    let missingFx = false
    const convert = (v: number | null): number | null => {
      if (v === null || p === null) return null
      if (!fxRates) return (p.currency ?? "USD").toUpperCase() === "USD" ? v : (missingFx = true, null)
      const r = toUsd(v, p.currency, fxRates)
      if (r.missingRate) { missingFx = true; return null }
      return r.usd
    }
    const providedOpening = convert(p?.opening_balance ?? null)
    const providedClosing = convert(p?.closing_balance ?? null)

    // System-derived outranks typed (CPA condition) …
    const opening_usd = b.derived_beginning ?? providedOpening
    const opening_source: BankBalanceMerge["opening_source"] =
      b.derived_beginning !== null ? "statements" : (providedOpening !== null ? (p as ProvidedBankBalance).source : null)
    const closing_usd = b.reported_ending ?? providedClosing
    const closing_source: BankBalanceMerge["closing_source"] =
      b.reported_ending !== null ? "statements" : (providedClosing !== null ? (p as ProvidedBankBalance).source : null)

    // … and a disagreement between the two is a FINDING, not a silent pick.
    const provided_conflicts_derived =
      (b.derived_beginning !== null && providedOpening !== null && Math.abs(b.derived_beginning - providedOpening) > tolerance) ||
      (b.reported_ending !== null && providedClosing !== null && Math.abs(b.reported_ending - providedClosing) > tolerance)

    const expected_closing_usd = opening_usd !== null ? opening_usd + b.net_movement : null
    const delta_usd = expected_closing_usd !== null && closing_usd !== null
      ? expected_closing_usd - closing_usd
      : null
    const tie: TieStatus = delta_usd === null
      ? "unverifiable"
      : (Math.abs(delta_usd) <= tolerance ? "ok" : "mismatch")

    return {
      bank_key: b.bank_key,
      opening_usd,
      opening_source,
      closing_usd,
      closing_source,
      expected_closing_usd,
      delta_usd,
      tie,
      provided_conflicts_derived,
      missing_fx_rate: missingFx,
    }
  })

  const missing_openings = merged.filter(m => m.opening_usd === null).map(m => m.bank_key)
  const allCovered = banks.length > 0 && missing_openings.length === 0
  const total_opening_usd = allCovered ? merged.reduce((s, m) => s + (m.opening_usd as number), 0) : null
  const total_opening_source: BankBalancesSummary["total_opening_source"] = !allCovered
    ? null
    : merged.every(m => m.opening_source === "statements") ? "statements" : "provided"

  return {
    banks: merged,
    total_opening_usd,
    total_opening_source,
    missing_openings,
    mismatched_banks: merged.filter(m => m.tie === "mismatch").map(m => m.bank_key),
  }
}
