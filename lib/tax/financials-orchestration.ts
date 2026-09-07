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
import { validatedExtraction, priorBeginningCta, type PriorReturnCaseRecord } from "./prior-return-case"
import { resolveClientSubmission } from "./resolve-submission"

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

/** Group the wizard's flattened member repeater keys (member_{idx}_member_*)
 *  by member index. member_count is authoritative when present — indexed
 *  keys above it are leftovers from removed members and must NOT become
 *  partners. Shared by every extractor below so they can't drift apart. */
function groupWizardMemberFields(submittedData: Record<string, unknown>): Map<number, Record<string, unknown>> {
  const byIdx = new Map<number, Record<string, unknown>>()
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
  return byIdx
}

/** A member's `type` field is the ONLY signal that decides whether their
 *  `company_name` field means anything — a company_name value must never
 *  win for an individual member, no matter how it got there. Shared so a
 *  future reader can't reintroduce the ungated check by hand. Donato Ciardo
 *  (2026-09-01): his individual member entry carried a stray company_name
 *  (the LLC's own name) alongside real first/last names; the ungated check
 *  used it as the member's name, dropping him from his own K-1 and crediting
 *  the LLC itself with 99% ownership. */
function isCompanyMember(fields: Record<string, unknown>): boolean {
  return String(fields.type ?? "") === "company"
}

/** Pull member rows out of the wizard's flattened repeater keys
 *  (member_{idx}_member_first_name / _member_company_name / _member_ownership_pct).
 *  Exported for tests. */
export function extractWizardMembers(submittedData: Record<string, unknown>): OwnershipSource[] {
  const byIdx = groupWizardMemberFields(submittedData)
  const out: OwnershipSource[] = []
  for (const [, fields] of Array.from(byIdx.entries()).sort((a, b) => a[0] - b[0])) {
    const name = isCompanyMember(fields) && fields.company_name
      ? String(fields.company_name)
      : `${fields.first_name ?? ""} ${fields.last_name ?? ""}`.trim()
    if (!name) continue
    const pctRaw = Number(fields.ownership_pct)
    out.push({ name, pct: Number.isFinite(pctRaw) && fields.ownership_pct !== "" && fields.ownership_pct !== null && fields.ownership_pct !== undefined ? pctRaw : null })
  }
  if (out.length > 0) return out

  // The LEGACY standalone tax form (still live, app/tax-form/[token]) sends
  // additional co-members as an `additional_members` array — a completely
  // different shape from the flat member_{idx}_… keys above, which this
  // function's regex cannot match at all. Before this fallback existed, any
  // account submitted through that form silently lost every co-member from
  // ownership resolution (not merely misnamed — absent). Confirmed live on
  // 2 real accounts (2026-09-01): PlayLover International LLC and Easy
  // English LLC, both 50/50 MMLLCs whose second partner was invisible to
  // K-1/capital-account resolution. Each row already carries a ready-made
  // full name + pct (member_name / member_ownership_pct) — no company/
  // individual ambiguity to gate on, unlike the flat-key shape above. The
  // submitting owner (owner_first_name/owner_last_name) is NOT itself one of
  // these rows, same as the flat-key path's caller-side fallback below.
  const additionalMembers = submittedData.additional_members
  if (Array.isArray(additionalMembers) && additionalMembers.length > 0) {
    const owner = extractWizardOwner(submittedData)
    if (owner) out.push(owner)
    for (const raw of additionalMembers as Array<Record<string, unknown>>) {
      const name = String(raw?.member_name ?? "").trim()
      if (!name) continue
      const pctRaw = Number(raw?.member_ownership_pct)
      out.push({ name, pct: Number.isFinite(pctRaw) && raw?.member_ownership_pct !== "" && raw?.member_ownership_pct !== null && raw?.member_ownership_pct !== undefined ? pctRaw : null })
    }
  }
  return out
}

export interface WizardMemberResidence {
  /** Ownership percentage, or null when the wizard didn't collect one for this member. */
  pct: number | null
  /** Raw (unnormalized) value of member_{idx}_member_residence_country — where
   *  this INDIVIDUAL member physically lives today, distinct from citizenship
   *  (components/portal/wizard/wizard-configs.ts). Always null for a company
   *  member: the wizard only asks member_company_country there, which is the
   *  company's REGISTRATION jurisdiction (a legal-status fact, parallel to
   *  citizenship) — not where anyone lives, so it is not a residence
   *  substitute. Callers normalize with residenceCountryToIso. */
  residenceCountry: string | null
}

/** Pull each member's ownership % + individual physical-residence country out
 *  of the wizard's flattened repeater keys. Built for the tax-purpose
 *  residence-country fix (Antonio, 2026-08-19): the company's own address is
 *  not a member's address — each member declares where they actually live in
 *  their own tax-wizard step, not in the OA/CRM record. Exported for tests. */
export function extractWizardMemberResidences(submittedData: Record<string, unknown>): WizardMemberResidence[] {
  const byIdx = groupWizardMemberFields(submittedData)
  const out: WizardMemberResidence[] = []
  for (const [, fields] of Array.from(byIdx.entries()).sort((a, b) => a[0] - b[0])) {
    const pctRaw = Number(fields.ownership_pct)
    const pct = Number.isFinite(pctRaw) && fields.ownership_pct !== "" && fields.ownership_pct !== null && fields.ownership_pct !== undefined ? pctRaw : null
    const residenceCountry = isCompanyMember(fields) || !fields.residence_country ? null : String(fields.residence_country)
    out.push({ pct, residenceCountry })
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

/**
 * Assemble + resolve ownership for an account-year from its three sources
 * (prior K-1s, wizard, account_contacts) — the ONE place this happens, so
 * `getFinancialsView` and the lightweight ownership-only check below can
 * never independently drift (this file's own long-standing warning about a
 * completeness check re-derived in multiple places applies here too — see
 * coverage.ts). Also returns `priorReturn` since callers need it beyond
 * ownership (the draft's beginning-balance carry).
 */
async function resolveAccountOwnership(accountId: string, taxYear: number): Promise<{ ownership: OwnershipResolution; priorReturn: PriorReturnCaseRecord | null }> {
  const sub = await resolveClientSubmission<{ submitted_data: Record<string, unknown> | null; prior_return_extracted: PriorReturnCaseRecord | null }>(
    supabaseAdmin, accountId, taxYear, "submitted_data, prior_return_extracted",
  )
  const submittedData = sub?.submitted_data ?? {}
  const priorReturn = sub?.prior_return_extracted ?? null

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

  const priorExtraction = validatedExtraction(priorReturn)
  const priorK1s: OwnershipSource[] = priorExtraction
    ? priorExtraction.k1s.map(k => ({ name: k.partner_name, pct: k.ownership_pct }))
    : []

  const wizardMembers = extractWizardMembers(submittedData)
  if (wizardMembers.length === 0) {
    const owner = extractWizardOwner(submittedData)
    if (owner) wizardMembers.unshift(owner)
  }

  return { ownership: resolveOwnership({ priorK1s, wizardMembers, accountContacts }), priorReturn }
}

/**
 * Does this account+year have a BROKEN ownership split right now — members
 * with stated percentages that don't add to 100 (never "not yet entered",
 * which stays non-blocking; see ownership-resolution.ts::ownershipIsBroken)?
 * Cheap and targeted like getAccountStructuralProblem below — assembles just
 * the three ownership sources, no bank_transactions/full draft — for the
 * routes that must refuse BEFORE computing anything (2026-08-22, Antonio:
 * "before the tool runs any profit and loss, check ownership first"):
 * download, re-run/generate, and forking this account as a fork source.
 * Returns the client-facing message (member names + %s) when broken, null
 * when fine — same wording gate 5 uses, via the same describeBrokenOwnership().
 */
export async function getAccountOwnershipProblem(accountId: string, taxYear: number): Promise<string | null> {
  const { describeBrokenOwnership } = await import("./ownership-resolution")
  const { ownership } = await resolveAccountOwnership(accountId, taxYear)
  return describeBrokenOwnership(ownership)
}

export async function getFinancialsView(
  accountId: string,
  taxYear: number,
  opts: {
    /** Skip the W6 ownership sync-back (default: run it, unchanged). Needed
     *  when this view is being computed only to CHECK whether a prior year is
     *  trustworthy enough to auto-carry from (prior-return-correction.ts) —
     *  that check must be read-only; merely opening it must never silently
     *  rewrite account_contacts.ownership_pct (round-3 bug-hunter major). */
    skipOwnershipSync?: boolean
  } = {},
): Promise<FinancialsView> {
  // Ownership assembly + resolution (three sources: prior K-1s, wizard,
  // account_contacts) lives in resolveAccountOwnership — the one place it
  // happens, shared with getAccountOwnershipProblem below, so the two can
  // never independently drift. This also carries priorReturn, needed further
  // down for the draft's beginning-balance carry.
  //
  // Round-6 bug-hunter blocker, still relevant to the submission read inside
  // resolveAccountOwnership: it used to be a raw `.eq("status", "completed")`
  // query — the exact "Rule A" anti-pattern resolve-submission.ts documents
  // as the cause of a real 2026-08-03 production incident on this same
  // table, and which every OTHER reader in this feature (the main view
  // route, attest, the three new prior-return routes) was already fixed to
  // avoid. This function — the one they all route through for the view
  // itself — was the one call site the original fix missed. `status` flips
  // completed→reviewed the moment staff run the ordinary "apply changes"
  // step (a routine, common action, not an edge case — historically the
  // MAJORITY state), at which point this query found NOTHING and silently
  // returned an empty view: no wizard members, no validated prior return,
  // beginning balances quietly falling back to statements instead of the
  // client's real filed figures — on every reviewed account, undermining
  // gate 7 / the carry-check / the correction form / the actual filed Excel
  // (buildFinancialsWorkbookForAccount below calls this same function) at
  // exactly the accounts most likely to need them.
  const { ownership, priorReturn } = await resolveAccountOwnership(accountId, taxYear)

  // Paginated read — buildFinancialDraft re-sorts internally, so `id` order is
  // fine here; the point is to get EVERY row past the 1000-row cap (a >1000-tx
  // account otherwise had its P&L/BS/gates computed on a truncated set).
  const txRows = await fetchAllBankTransactionsByYear<Record<string, unknown>>(
    accountId,
    taxYear,
    "id, transaction_date, description, counterparty, amount, currency, category, subcategory, bank_name, account_type, account_ref, balance_after, ai_bucket, notes",
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

  // W6 sync-back — only a complete, conflict-free resolution is auto-written.
  if (ownership.complete && ownership.conflicts.length === 0 && !opts.skipOwnershipSync) {
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

  const draft = buildFinancialDraft({ taxYear, transactions, members: ownership.members, priorReturn, defaultUncategorizedBySign: true, fxRates, providedBalances, beginningCta: priorBeginningCta(priorReturn) })
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

/**
 * Does this account+year, right now, have a structural data problem (an
 * unreadable statement file, or an unresolved/incomplete missing-months
 * question)? Same predicate the review-screen GET route surfaces
 * (lib/tax/coverage.ts::hasStructuralProblem), computed fresh here for the
 * OTHER place it must be enforced server-side: the Excel download route
 * (app/api/portal/tax-financials/download/route.ts) — a direct hit on that
 * endpoint bypasses whatever the review screen shows, so it needs its own
 * server-side check, not a UI-only hide (2026-08-20 hard-stop plan, all
 * three council reviewers independently flagged the download route as
 * unguarded).
 */
export async function getAccountStructuralProblem(accountId: string, taxYear: number): Promise<boolean> {
  const sub = await resolveClientSubmission<{ financials_meta: Record<string, unknown> | null }>(
    supabaseAdmin, accountId, taxYear, "financials_meta",
  )
  const meta = (sub?.financials_meta ?? {}) as Record<string, unknown>

  const { data: ingestJobs } = await supabaseAdmin
    .from("job_queue")
    .select("status, result, payload")
    .eq("job_type", "ingest_bank_statement")
    .eq("account_id", accountId)
    .in("status", ["pending", "processing", "failed", "completed"])
  const { computeIngestFileStates, summarizeIngestFileStates } = await import("./ingest-file-status")
  const stateCounts = summarizeIngestFileStates(computeIngestFileStates(
    (ingestJobs ?? []) as Array<{ status: string; result: { ok?: boolean; steps?: Array<{ detail?: string }> } | null; payload: { tax_year?: number | string; path?: string } | null }>,
    taxYear,
  ))

  const sources = await fetchAllBankTransactionsByYear<{ bank_name: string; account_type: string | null; transaction_date: string }>(
    accountId, taxYear, "bank_name, account_type, transaction_date",
  )
  const { coverageQuestions, unansweredCoverage, incompleteCoverage, hasStructuralProblem } = await import("./coverage")
  const answers = (meta.coverage_answers ?? {}) as import("./coverage").CoverageAnswers
  const covQs = coverageQuestions(sources, taxYear)

  return hasStructuralProblem({
    ingestFailed: stateCounts.failed,
    failedFilesOverridden: meta.failed_files_override != null,
    quarantined: stateCounts.quarantined,
    unansweredCoverage: unansweredCoverage(covQs, answers).length,
    incompleteCoverage: incompleteCoverage(covQs, answers).length,
  })
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
