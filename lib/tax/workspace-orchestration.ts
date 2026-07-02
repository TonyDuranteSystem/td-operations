/**
 * Workspace financials orchestration — the standalone P&L tool's twin of
 * `getFinancialsView`, assembling the SAME `FinancialsView` (draft + gates +
 * ownership + completeness) from the workspace tables instead of a real
 * client's account. The pure engine (`buildFinancialDraft`, `evaluateGates`,
 * `resolveOwnership`, `buildCompletenessSummary`) is reused UNCHANGED.
 *
 * ISOLATION: reads only workspace tables (+ the global irs_exchange_rates).
 * Crucially it does NOT call `syncOwnershipBack` — a workspace never writes
 * resolved percentages back to the real `account_contacts` (sealed leak #3).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { fetchAllPaged } from "@/lib/bank-transactions-fetch"
import { buildFinancialDraft, type DraftTransaction } from "./financials-engine"
import { type FxRates } from "./fx"
import { evaluateGates, canConfirm } from "./verification-gates"
import { buildCompletenessSummary } from "./completeness"
import { resolveOwnership, type OwnershipSource } from "./ownership-resolution"
import { validatedExtraction, type PriorReturnCaseRecord } from "./prior-return-case"
import { type FinancialsView } from "./financials-orchestration"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function getWorkspaceFinancialsView(workspaceId: string): Promise<FinancialsView> {
  // 1. Workspace meta — tax year, company name, prior-return snapshot.
  const { data: ws, error: wsErr } = await db
    .from("pnl_workspaces")
    .select("tax_year, company_name, prior_return_snapshot")
    .eq("id", workspaceId)
    .maybeSingle()
  if (wsErr) throw new Error(`Failed to load workspace: ${wsErr.message}`)
  if (!ws) throw new Error("Workspace not found")
  const taxYear = ws.tax_year as number
  const priorReturn = (ws.prior_return_snapshot ?? null) as PriorReturnCaseRecord | null

  // 2. Transactions (paged past the 1000-row cap), engine-shaped.
  const txRows = await fetchAllPaged<Record<string, unknown>>(async (from, to) => {
    const { data, error } = await db
      .from("pnl_workspace_transactions")
      .select("id, transaction_date, description, counterparty, amount, currency, category, subcategory, bank_name, account_type, balance_after")
      .eq("workspace_id", workspaceId)
      .order("id", { ascending: true })
      .range(from, to)
    if (error) throw new Error(`Failed to load workspace transactions: ${error.message}`)
    return (data ?? []) as Record<string, unknown>[]
  })
  const transactions = txRows.map(r => ({ ...r, amount: Number(r.amount) })) as DraftTransaction[]

  // 3. IRS yearly-average FX rates for any non-USD currency present (global table).
  const foreignCurrencies = Array.from(new Set(
    transactions.map(t => (t.currency ?? "").trim().toUpperCase()).filter(c => c && c !== "USD"),
  ))
  let fxRates: FxRates | undefined
  if (foreignCurrencies.length > 0) {
    const { data: rateRows } = await db
      .from("irs_exchange_rates")
      .select("currency, rate_to_usd")
      .eq("tax_year", taxYear)
      .in("currency", foreignCurrencies)
    fxRates = {}
    for (const r of (rateRows ?? []) as Array<{ currency: string; rate_to_usd: number }>) {
      fxRates[r.currency.toUpperCase()] = Number(r.rate_to_usd)
    }
  }

  // 4. Members — the workspace's own roster IS the authoritative member list.
  const { data: memberRows } = await db
    .from("pnl_workspace_members")
    .select("display_name, ownership_pct")
    .eq("workspace_id", workspaceId)
  const wizardMembers: OwnershipSource[] = ((memberRows ?? []) as Array<{ display_name: string | null; ownership_pct: number | string | null }>)
    .map(m => ({
      name: (m.display_name ?? "").trim(),
      pct: m.ownership_pct === null || m.ownership_pct === undefined || m.ownership_pct === "" ? null : Number(m.ownership_pct),
    }))
    .filter(m => m.name.length > 0)

  // 5. Prior-year K-1 %s from the workspace's prior-return snapshot (if validated).
  const priorExtraction = validatedExtraction(priorReturn)
  const priorK1s: OwnershipSource[] = priorExtraction
    ? priorExtraction.k1s.map(k => ({ name: k.partner_name, pct: k.ownership_pct }))
    : []

  // 6. Ownership resolution — NO account_contacts (workspace roster is complete),
  //    and NO sync-back to any real table.
  const ownership = resolveOwnership({ priorK1s, wizardMembers, accountContacts: [] })

  // 7. Draft + gates + completeness. ONE deliberate divergence from the portal
  // path (2026-07-02, B&P $594k incident): the STAFF workspace does NOT fold
  // uncategorized rows by sign. An account the categorizer doesn't understand
  // must surface as visibly-unclassified money — never as silent income. The
  // client portal keeps folding (its attestation-based review flow, 2026-06-17
  // policy). This also aligns the on-screen totals with the Excel download,
  // which has always computed unfolded + warning.
  const draft = buildFinancialDraft({ taxYear, transactions, members: ownership.members, priorReturn, defaultUncategorizedBySign: false, fxRates })
  const gates = evaluateGates({ draft, ownership, priorReturn })
  const missingFxCurrencies = foreignCurrencies.filter(c => !fxRates || !(fxRates[c] > 0))
  const completeness = buildCompletenessSummary({ gates, draft, missingFxCurrencies })

  return { draft, gates, canConfirm: canConfirm(gates), completeness, ownership, priorReturn, transactionCount: transactions.length }
}
