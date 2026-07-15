/**
 * Financials orchestration (Slice 7) — the I/O layer that assembles the pure
 * engine's inputs from the database and returns the complete financials view
 * (draft + gates + ownership) for an account-year.
 *
 * Consumers: the portal review screen (Slice 8) and staff tooling. The draft
 * is COMPUTED on demand, never stored — bank_transactions is the source of
 * truth, so a deleted upload or a recategorized row is reflected on the next
 * load with no regeneration step.
 *
 * Ownership sync-back (W6): when the resolution is complete and conflict-free,
 * resolved percentages are written back to account_contacts (both real MMLLC
 * clients had NULLs there). Conflicted or incomplete resolutions are NEVER
 * auto-written — staff resolve those.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { fetchAllBankTransactionsByYear } from "@/lib/bank-transactions-fetch"
import { buildFinancialDraft, type DraftTransaction, type FinancialDraft } from "./financials-engine"
import { type FxRates } from "./fx"
import { evaluateGates, canConfirm, type GateResult } from "./verification-gates"
import { buildCompletenessSummary, type CompletenessSummary } from "./completeness"
import { resolveOwnership, type OwnershipResolution, type OwnershipSource } from "./ownership-resolution"
import { validatedExtraction, type PriorReturnCaseRecord } from "./prior-return-case"

export interface FinancialsView {
  draft: FinancialDraft
  gates: GateResult[]
  canConfirm: boolean
  /** Plain-English "what's complete / what's uncertain" + the income question
   *  + the accept-as-is gate (dev_task 95127bb2). */
  completeness: CompletenessSummary
  ownership: OwnershipResolution
  priorReturn: PriorReturnCaseRecord | null
  transactionCount: number
  /** Raw provided per-bank balance rows (S2 slice 2) — what the balances
   *  editor displays; the merged/tie view lives in draft.bank_balances. */
  providedBalances: Array<{ bank_key: string; currency: string; opening_balance: number | null; closing_balance: number | null; source: "client" | "staff" }>
}

/** Pull member rows out of the wizard's flattened repeater keys
 *  (member_{idx}_member_first_name / _member_company_name / _member_ownership_pct).
 *  Exported for tests. */
export function extractWizardMembers(submittedData: Record<string, unknown>): OwnershipSource[] {
  const byIdx = new Map<number, Record<string, unknown>>()
  // member_count is authoritative when present — indexed keys above it are
  // leftovers from removed members and must NOT become partners.
  const countRaw = Number(submittedData.member_count)
  const maxIdx = Number.isFinite(countRaw) && countRaw > 0 ? countRaw - 1 : Infinity
  for (const [key, value] of Object.entries(submittedData)) {
    const m = key.match(/^member_(\d+)_member_(.+)$/)
    if (!m) continue
    const idx = Number(m[1])
    if (idx > maxIdx) continue
    if (!byIdx.has(idx)) byIdx.set(idx, {})
    byIdx.get(idx)![m[2]] = value
  }
  const out: OwnershipSource[] = []
  for (const [, fields] of Array.from(byIdx.entries()).sort((a, b) => a[0] - b[0])) {
    const name = fields.company_name
      ? String(fields.company_name)
      : `${fields.first_name ?? ""} ${fields.last_name ?? ""}`.trim()
    if (!name) continue
    const pctRaw = Number(fields.ownership_pct)
    out.push({ name, pct: Number.isFinite(pctRaw) && fields.ownership_pct !== "" && fields.ownership_pct !== null && fields.ownership_pct !== undefined ? pctRaw : null })
  }
  return out
}

/** The submitting owner from the LEGACY wizard's owner step — pct intentionally
 *  null: that form never asked the owner's own %, and we never infer it as the
 *  remainder (a member's typo would silently shift the owner's share).
 *  Only consulted when a submission has NO member list (the redesigned wizard
 *  always emits one and has no owner step). Exported for tests. */
export function extractWizardOwner(submittedData: Record<string, unknown>): OwnershipSource | null {
  const name = `${submittedData.owner_first_name ?? ""} ${submittedData.owner_last_name ?? ""}`.trim()
  return name ? { name, pct: null } : null
}

export async function getFinancialsView(accountId: string, taxYear: number, opts: { skipPriorCarry?: boolean } = {}): Promise<FinancialsView> {
  // Latest completed submission carries the wizard answers + the prior-return record.
  const { data: sub } = await supabaseAdmin
    .from("tax_return_submissions")
    .select("submitted_data, prior_return_extracted")
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle() as { data: { submitted_data: Record<string, unknown> | null; prior_return_extracted: PriorReturnCaseRecord | null } | null }

  const submittedData = sub?.submitted_data ?? {}
  // Cross-year carry-forward (2026-07-15): year N's beginning balances must come
  // from OUR corrected/finalized year N-1 books, NOT a stale extraction of the
  // originally-filed prior return. (Dynamiq trap: 2025 was starting from the
  // mis-filed 2024's $1,142,397 cash instead of the corrected $391,863.70.) When
  // we hold complete, self-tying N-1 books, synthesize the prior from THEIR
  // ending (cash + per-member ending capital), overriding the uploaded extraction.
  let priorReturn = sub?.prior_return_extracted ?? null
  if (!opts.skipPriorCarry) {
    const carried = await carryPriorFromOurBooks(accountId, taxYear)
    if (carried) priorReturn = carried
  }

  // Paginated read — buildFinancialDraft re-sorts internally, so `id` order is
  // fine here; the point is to get EVERY row past the 1000-row cap (a >1000-tx
  // account otherwise had its P&L/BS/gates computed on a truncated set).
  const txRows = await fetchAllBankTransactionsByYear<Record<string, unknown>>(
    accountId,
    taxYear,
    "id, transaction_date, description, counterparty, amount, currency, category, subcategory, bank_name, account_type, account_ref, balance_after, ai_bucket",
  )
  const transactions = txRows.map(r => ({ ...r, amount: Number(r.amount) })) as DraftTransaction[]

  // Phase 2 — IRS yearly-average rates for any non-USD currency present, so the
  // engine can express foreign-currency amounts in USD (lib/tax/fx.ts). USD needs
  // no rate; an all-USD dataset skips this entirely (fxRates stays undefined).
  const foreignCurrencies = Array.from(new Set(
    transactions.map(t => (t.currency ?? "").trim().toUpperCase()).filter(c => c && c !== "USD"),
  ))
  let fxRates: FxRates | undefined
  if (foreignCurrencies.length > 0) {
    const { data: rateRows } = await supabaseAdmin
      .from("irs_exchange_rates")
      .select("currency, rate_to_usd")
      .eq("tax_year", taxYear)
      .in("currency", foreignCurrencies)
    fxRates = {}
    for (const r of (rateRows ?? []) as Array<{ currency: string; rate_to_usd: number }>) {
      fxRates[r.currency.toUpperCase()] = Number(r.rate_to_usd)
    }
  }

  const { data: links } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id, ownership_pct, contacts(first_name, last_name)")
    .eq("account_id", accountId)
  const accountContacts = ((links ?? []) as unknown as Array<{ contact_id: string; ownership_pct: number | null; contacts: { first_name: string | null; last_name: string | null } | null }>)
    .filter(l => l.contacts)
    .map(l => ({
      name: `${l.contacts!.first_name ?? ""} ${l.contacts!.last_name ?? ""}`.trim(),
      pct: l.ownership_pct,
      contact_id: l.contact_id,
    }))
    .filter(c => c.name.length > 0)

  // Prior-year K-1 ownership %s — from a client upload OR our own filed return.
  const priorExtraction = validatedExtraction(priorReturn)
  const priorK1s: OwnershipSource[] = priorExtraction
    ? priorExtraction.k1s.map(k => ({ name: k.partner_name, pct: k.ownership_pct }))
    : []

  const wizardMembers = extractWizardMembers(submittedData)
  // The owner_* keys only seed the roster when there is NO member list at all
  // (legacy pre-redesign submissions). The redesigned wizard has no owner step
  // — the filler is one of the members — but a draft reset reuses the same
  // submission row, so stale owner_* keys can survive next to the fresh
  // member list. Unshifting the stale owner injected a phantom member on top
  // of the client's declared 50/50 (2026-06-12, Antonio's catch — % hit 200).
  if (wizardMembers.length === 0) {
    const owner = extractWizardOwner(submittedData)
    if (owner) wizardMembers.unshift(owner)
  }

  const ownership = resolveOwnership({ priorK1s, wizardMembers, accountContacts })

  // W6 sync-back — only a complete, conflict-free resolution is auto-written.
  // Skipped when this view is being computed only to carry into a later year
  // (skipPriorCarry) — a prior-year read must have no write side effects.
  if (ownership.complete && ownership.conflicts.length === 0 && !opts.skipPriorCarry) {
    await syncOwnershipBack(accountId, ownership)
  }

  // Portal tax review uses the "default + flag exceptions" policy: a real
  // client's bank export has hundreds of scattered merchants, so asking the
  // owner to categorize each one does not scale (Dynamiq: 287 distinct
  // merchants). Instead every still-uncategorized row is defaulted by sign
  // (outflow → business expense, inflow → income) and the owner only flags the
  // exceptions (personal spend). This makes the P&L complete and unblocks gate 6.
  // S2 slice 2 — per-bank balance anchors recorded by the client/staff.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: balanceRows } = await (supabaseAdmin as any) // table not yet in database.types.ts
    .from("account_bank_balances")
    .select("bank_key, currency, opening_balance, closing_balance, source")
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
  const providedBalances = ((balanceRows ?? []) as Array<Record<string, unknown>>).map(r => ({
    bank_key: String(r.bank_key),
    currency: String(r.currency ?? "USD"),
    opening_balance: r.opening_balance === null ? null : Number(r.opening_balance),
    closing_balance: r.closing_balance === null ? null : Number(r.closing_balance),
    source: (r.source === "staff" ? "staff" : "client") as "client" | "staff",
  }))

  const draft = buildFinancialDraft({ taxYear, transactions, members: ownership.members, priorReturn, defaultUncategorizedBySign: true, fxRates, providedBalances })
  const gates = evaluateGates({ draft, ownership, priorReturn })

  // Completeness summary (dev_task 95127bb2): translate the failing/na gates +
  // structured draft signals into plain-English "what's still uncertain" items.
  // missingFxCurrencies = non-USD currencies present with no IRS rate on file
  // (those amounts are shown unconverted until the rate is added).
  const missingFxCurrencies = foreignCurrencies.filter(c => !fxRates || !(fxRates[c] > 0))
  const completeness = buildCompletenessSummary({ gates, draft, missingFxCurrencies })

  return { draft, gates, canConfirm: canConfirm(gates), completeness, ownership, priorReturn, transactionCount: transactions.length, providedBalances }
}

/**
 * Year N's prior-year source, synthesized from OUR OWN corrected year N-1 books
 * when we hold them (transactions ingested for N-1) AND they self-tie — so
 * beginning cash + per-member beginning capital carry from the corrected close,
 * not a stale extraction of the originally-filed (possibly wrong) prior return.
 * Returns null when there is no usable N-1 (caller keeps the uploaded / none
 * path unchanged). Computes N-1 with skipPriorCarry so it never recurses to N-2.
 *
 * v1 reads the LIVE corrected N-1 draft; once the attestation-snapshot lands
 * (dev_task fa37121d) this should read the frozen attested N-1 snapshot instead.
 */
async function carryPriorFromOurBooks(accountId: string, taxYear: number): Promise<PriorReturnCaseRecord | null> {
  const priorYear = taxYear - 1
  const { count } = await supabaseAdmin
    .from("bank_transactions")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("tax_year", priorYear)
  if (!count || count === 0) return null

  const priorView = await getFinancialsView(accountId, priorYear, { skipPriorCarry: true })
  const d = priorView.draft
  if (d.beginning_cash === null) return null            // N-1 has no resolved beginning — not carryable
  if (Math.abs(d.balance_sheet_check) > 1) return null  // never carry a prior year that doesn't tie
  return buildPriorFromDraft(d, priorYear, new Date().toISOString())
}

/** PURE: map a corrected year N-1 draft into the prior-return record the engine
 *  reads for year N (Schedule L ending cash + per-member K-1 ending capital →
 *  next year's beginning). Exported for tests. Members carry by NAME (K-1
 *  partner_name), so a renamed/changed member roster across years won't carry —
 *  a known roster-reconciliation limitation flagged for follow-up. */
export function buildPriorFromDraft(draft: FinancialDraft, priorYear: number, nowIso: string): PriorReturnCaseRecord {
  return {
    case: "we_filed",
    status: "validated",
    tax_return_id: null,
    note: `Beginning balances carried from our corrected ${priorYear} books.`,
    recorded_at: nowIso,
    source: "our_corrected_books",
    issues: [],
    extracted: {
      form_type: "1065",
      tax_year: priorYear,
      ein: null,
      schedule_l: {
        beginning: { cash: 0, total_assets: 0, total_liabilities: 0, capital: 0 },
        ending: { cash: draft.ending_cash, total_assets: draft.total_assets, total_liabilities: draft.total_liabilities, capital: draft.ending_capital_total },
      },
      m2: { beginning_capital: draft.beginning_capital_total, ending_capital: draft.ending_capital_total },
      k1s: draft.members.map(m => ({ partner_name: m.name, ownership_pct: m.pct, ending_capital: m.ending_capital })),
    },
  }
}

/**
 * Build the P&L + Balance Sheet Excel workbook for an account-year FROM THE
 * ENGINE DRAFT — the single filing artifact. Every surface that hands a client
 * or accountant an Excel (the portal download AND the post-attestation Drive
 * archive the accountant files from) MUST go through here, so the accountant
 * never receives numbers that differ from the client's screen (Phase 4 fix:
 * the accountant hand-off used to build from the legacy transaction-based
 * generator, which diverged from the corrected engine). Returns null when the
 * account has no transactions yet. Pure rendering lives in buildFinancialsWorkbook.
 */
export async function buildFinancialsWorkbookForAccount(
  accountId: string,
  taxYear: number,
): Promise<{ buffer: Buffer; fileName: string } | null> {
  const view = await getFinancialsView(accountId, taxYear)
  if (view.transactionCount === 0) return null

  const { fetchAllBankTransactionsByYear } = await import("@/lib/bank-transactions-fetch")
  const txRows = await fetchAllBankTransactionsByYear<{
    transaction_date: string; description: string | null; counterparty: string | null
    amount: number; currency: string | null; category: string | null; subcategory: string | null
    bank_name: string | null; account_type: string | null; is_related_party: boolean | null; transaction_ref: string | null
  }>(
    accountId, taxYear,
    "transaction_date, description, counterparty, amount, currency, category, subcategory, bank_name, account_type, is_related_party, transaction_ref",
    { column: "transaction_date", ascending: true },
  )

  const { data: account } = await supabaseAdmin.from("accounts").select("company_name").eq("id", accountId).single()
  const companyName = account?.company_name || "Company"

  const { getIrsRate } = await import("@/lib/pnl-generator")
  const rates: Record<string, number> = {}
  for (const c of Array.from(new Set(txRows.map(t => t.currency ?? "USD")))) rates[c] = await getIrsRate(c, taxYear)

  const { buildFinancialsWorkbook } = await import("@/lib/tax/financials-excel")
  return buildFinancialsWorkbook({ companyName, taxYear, draft: view.draft, transactions: txRows, rates })
}

/** Write resolved percentages back to account_contacts where they differ. */
export async function syncOwnershipBack(accountId: string, ownership: OwnershipResolution): Promise<number> {
  let updated = 0
  for (const m of ownership.members) {
    if (!m.contact_id || m.pct === null || m.source === "account_contacts") continue
    const { error } = await supabaseAdmin
      .from("account_contacts")
      .update({ ownership_pct: m.pct })
      .eq("account_id", accountId)
      .eq("contact_id", m.contact_id)
    if (!error) updated++
    else console.error(`[financials] ownership sync-back failed for ${m.name}: ${error.message}`)
  }
  return updated
}
