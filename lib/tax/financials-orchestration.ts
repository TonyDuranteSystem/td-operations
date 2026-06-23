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
import { toUsd, type FxRates } from "./fx"
import { evaluateGates, canConfirm, type GateResult } from "./verification-gates"
import { buildCompletenessSummary, type CompletenessSummary, type IncomeAnswer } from "./completeness"
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

export async function getFinancialsView(accountId: string, taxYear: number): Promise<FinancialsView> {
  // Latest completed submission carries the wizard answers + the prior-return record.
  const { data: sub } = await supabaseAdmin
    .from("tax_return_submissions")
    .select("submitted_data, prior_return_extracted, financials_meta")
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle() as { data: { submitted_data: Record<string, unknown> | null; prior_return_extracted: PriorReturnCaseRecord | null; financials_meta: Record<string, unknown> | null } | null }

  const submittedData = sub?.submitted_data ?? {}
  const priorReturn = sub?.prior_return_extracted ?? null
  const incomeAnswer = ((sub?.financials_meta?.income_attestation as { answer?: string } | undefined)?.answer ?? null) as IncomeAnswer | null

  // Paginated read — buildFinancialDraft re-sorts internally, so `id` order is
  // fine here; the point is to get EVERY row past the 1000-row cap (a >1000-tx
  // account otherwise had its P&L/BS/gates computed on a truncated set).
  const txRows = await fetchAllBankTransactionsByYear<Record<string, unknown>>(
    accountId,
    taxYear,
    "id, transaction_date, description, counterparty, amount, currency, category, subcategory, bank_name, account_type, balance_after",
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
  if (ownership.complete && ownership.conflicts.length === 0) {
    await syncOwnershipBack(accountId, ownership)
  }

  // Portal tax review uses the "default + flag exceptions" policy: a real
  // client's bank export has hundreds of scattered merchants, so asking the
  // owner to categorize each one does not scale (Dynamiq: 287 distinct
  // merchants). Instead every still-uncategorized row is defaulted by sign
  // (outflow → business expense, inflow → income) and the owner only flags the
  // exceptions (personal spend). This makes the P&L complete and unblocks gate 6.
  const draft = buildFinancialDraft({ taxYear, transactions, members: ownership.members, priorReturn, defaultUncategorizedBySign: true, fxRates })
  const gates = evaluateGates({ draft, ownership, priorReturn })

  // Completeness summary (dev_task 95127bb2) — the foreign/conversion movement
  // that drives the income question, plus any non-USD currency lacking a rate.
  // Conversion rows + non-USD rows, in USD, are the "is there an account we
  // don't see?" signal. Pairs may double-count — harmless for a ≥-floor gate
  // (it only ever makes the one-tap question MORE likely to ask).
  const foreignActivityTotal = transactions.reduce((sum, t) => {
    const cur = (t.currency ?? "").trim().toUpperCase()
    const isForeign = t.category === "conversion" || (cur !== "" && cur !== "USD")
    if (!isForeign) return sum
    const usd = fxRates ? toUsd(Number(t.amount), t.currency, fxRates).usd : Number(t.amount)
    return sum + Math.abs(usd)
  }, 0)
  const missingFxCurrencies = foreignCurrencies.filter(c => !fxRates || !(fxRates[c] > 0))
  const completeness = buildCompletenessSummary({ gates, draft, foreignActivityTotal, missingFxCurrencies, incomeAnswer })

  return { draft, gates, canConfirm: canConfirm(gates), completeness, ownership, priorReturn, transactionCount: transactions.length }
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
