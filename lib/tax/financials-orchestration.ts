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
import { buildFinancialDraft, type DraftTransaction, type FinancialDraft } from "./financials-engine"
import { evaluateGates, canConfirm, type GateResult } from "./verification-gates"
import { resolveOwnership, type OwnershipResolution, type OwnershipSource } from "./ownership-resolution"
import type { PriorReturnCaseRecord } from "./prior-return-case"

export interface FinancialsView {
  draft: FinancialDraft
  gates: GateResult[]
  canConfirm: boolean
  ownership: OwnershipResolution
  priorReturn: PriorReturnCaseRecord | null
  transactionCount: number
}

/** Pull member rows out of the wizard's flattened repeater keys
 *  (member_{idx}_member_first_name / _member_company_name / _member_ownership_pct).
 *  Exported for tests. */
export function extractWizardMembers(submittedData: Record<string, unknown>): OwnershipSource[] {
  const byIdx = new Map<number, Record<string, unknown>>()
  for (const [key, value] of Object.entries(submittedData)) {
    const m = key.match(/^member_(\d+)_member_(.+)$/)
    if (!m) continue
    const idx = Number(m[1])
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

/** The submitting owner from the wizard's owner step — pct intentionally null:
 *  the wizard never asks the owner's own %, and we never infer it as the
 *  remainder (a member's typo would silently shift the owner's share).
 *  Prior K-1s / account_contacts supply it via precedence. Exported for tests. */
export function extractWizardOwner(submittedData: Record<string, unknown>): OwnershipSource | null {
  const name = `${submittedData.owner_first_name ?? ""} ${submittedData.owner_last_name ?? ""}`.trim()
  return name ? { name, pct: null } : null
}

export async function getFinancialsView(accountId: string, taxYear: number): Promise<FinancialsView> {
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
  const priorReturn = sub?.prior_return_extracted ?? null

  const { data: txRows, error: txErr } = await supabaseAdmin
    .from("bank_transactions")
    .select("id, transaction_date, description, counterparty, amount, currency, category, subcategory, bank_name, account_type, balance_after")
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
  if (txErr) throw new Error(`Failed to load transactions: ${txErr.message}`)
  const transactions = (txRows ?? []).map(r => ({ ...r, amount: Number(r.amount) })) as DraftTransaction[]

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

  const priorK1s: OwnershipSource[] =
    priorReturn?.case === "filed_elsewhere" && priorReturn.status === "validated"
      ? priorReturn.extracted.k1s.map(k => ({ name: k.partner_name, pct: k.ownership_pct }))
      : []

  const wizardMembers = extractWizardMembers(submittedData)
  const owner = extractWizardOwner(submittedData)
  if (owner && !wizardMembers.some(m => m.name.toLowerCase() === owner.name.toLowerCase())) {
    wizardMembers.unshift(owner)
  }

  const ownership = resolveOwnership({ priorK1s, wizardMembers, accountContacts })

  // W6 sync-back — only a complete, conflict-free resolution is auto-written.
  if (ownership.complete && ownership.conflicts.length === 0) {
    await syncOwnershipBack(accountId, ownership)
  }

  const draft = buildFinancialDraft({ taxYear, transactions, members: ownership.members, priorReturn })
  const gates = evaluateGates({ draft, ownership, priorReturn })

  return { draft, gates, canConfirm: canConfirm(gates), ownership, priorReturn, transactionCount: transactions.length }
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
