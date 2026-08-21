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
import { validatedExtraction, priorBeginningCta, type PriorReturnCaseRecord } from "./prior-return-case"
import { type FinancialsView } from "./financials-orchestration"
import { filterMemberNames } from "./member-names"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** The staff workspace view = the shared FinancialsView + Validation Mode
 *  (staff-only; the portal's getFinancialsView never carries it). */
export type WorkspaceFinancialsView = FinancialsView & {
  validation: import("./validation-breakdown").ValidationBreakdown
}

export async function getWorkspaceFinancialsView(workspaceId: string): Promise<WorkspaceFinancialsView> {
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
      // notes + is_related_party ride the SAME fetch for Validation Mode
      // (provenance split / related-party summary) — one pass, no re-query.
      .select("id, transaction_date, description, counterparty, amount, currency, category, subcategory, bank_name, account_type, account_ref, balance_after, notes, is_related_party")
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
  const draft = buildFinancialDraft({ taxYear, transactions, members: ownership.members, priorReturn, defaultUncategorizedBySign: false, fxRates, beginningCta: priorBeginningCta(priorReturn) })
  const gates = evaluateGates({ draft, ownership, priorReturn })
  const missingFxCurrencies = foreignCurrencies.filter(c => !fxRates || !(fxRates[c] > 0))
  const completeness = buildCompletenessSummary({ gates, draft, missingFxCurrencies })

  // Validation Mode (2026-07-06): the breakdown is a BY-PRODUCT of this same
  // pass — same rows, same rates, same draft — so its runtime invariant
  // (breakdown totals ≡ draft totals) can only fail on a genuine engine bug,
  // never on a data race between two loads.
  const { buildValidationBreakdown } = await import("./validation-breakdown")
  const validation = buildValidationBreakdown({
    rows: txRows.map(r => ({
      id: String(r.id),
      description: (r.description as string | null) ?? null,
      counterparty: (r.counterparty as string | null) ?? null,
      amount: Number(r.amount),
      currency: (r.currency as string | null) ?? null,
      category: String(r.category ?? "uncategorized"),
      notes: (r.notes as string | null) ?? null,
      is_related_party: (r.is_related_party as boolean | null) ?? null,
    })),
    draft,
    fxRates,
    priorReturn,
    ownership,
    // Same name list the categorizer flags members with — the panel's
    // owner-exclusion must mirror the flag's inclusion (2026-07-07), which now
    // means the same usable-name rule too, or the panel excludes an owner the
    // categorizer never flagged (or vice versa).
    memberNames: filterMemberNames(wizardMembers.map(m => m.name)),
  })

  // providedBalances: [] — balance anchors are a BOOKS concept (account+year);
  // the standalone workspace scratch tool has no account to anchor to.
  return { draft, gates, canConfirm: canConfirm(gates), completeness, ownership, priorReturn, transactionCount: transactions.length, providedBalances: [], validation }
}

/**
 * Does THIS workspace, right now, have a structural data problem (an
 * unreadable statement file, or an unresolved/incomplete missing-months
 * question)? Same predicate the GET route surfaces to the UI
 * (lib/tax/coverage.ts::hasStructuralProblem), computed fresh here for the
 * ONE other place it must be enforced server-side: save-to-client
 * (lib/tax/workspace-save.ts). Deliberately re-queries rather than trusting
 * a client-sent flag — the same discipline this file's existingCount/
 * inFlightJobs checks already use.
 */
export async function getWorkspaceStructuralProblem(workspaceId: string): Promise<boolean> {
  const { data: ws } = await db
    .from("pnl_workspaces")
    .select("tax_year, coverage_answers")
    .eq("id", workspaceId)
    .maybeSingle()
  if (!ws) return false // no workspace to save from — the caller's own existence check handles this

  const { data: ingestJobs } = await supabaseAdmin
    .from("job_queue")
    .select("status, result, payload")
    .eq("job_type", "ingest_workspace_statement")
    .eq("related_entity_id", workspaceId)
    .in("status", ["pending", "processing", "failed", "completed"])
  const { computeIngestFileStates, summarizeIngestFileStates } = await import("./ingest-file-status")
  const fileStates = computeIngestFileStates(
    (ingestJobs ?? []) as Array<{ status: string; result: { ok?: boolean; steps?: Array<{ detail?: string }> } | null; payload: { tax_year?: number | string; path?: string } | null }>,
    0, // workspace job payloads never carry tax_year — see ingest-file-status.ts's documented no-op
  )
  const stateCounts = summarizeIngestFileStates(fileStates)

  const sources = await fetchAllPaged<{ bank_name: string; account_type: string | null; transaction_date: string }>(async (from, to) => {
    const { data, error } = await db
      .from("pnl_workspace_transactions")
      .select("bank_name, account_type, transaction_date")
      .eq("workspace_id", workspaceId)
      .order("id", { ascending: true })
      .range(from, to)
    if (error) throw new Error(error.message)
    return (data ?? []) as Array<{ bank_name: string; account_type: string | null; transaction_date: string }>
  })
  const { coverageQuestions, unansweredCoverage, incompleteCoverage, hasStructuralProblem } = await import("./coverage")
  const answers = (ws.coverage_answers ?? {}) as import("./coverage").CoverageAnswers
  const covQs = coverageQuestions(sources, Number(ws.tax_year))

  return hasStructuralProblem({
    ingestFailed: stateCounts.failed,
    failedFilesOverridden: false, // workspaces have no CRM override mechanism today
    unansweredCoverage: unansweredCoverage(covQs, answers).length,
    incompleteCoverage: incompleteCoverage(covQs, answers).length,
  })
}
