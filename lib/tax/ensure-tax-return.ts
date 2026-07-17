/**
 * ensureTaxReturnRecord — the payment chain's guarantee that a tax season is
 * TRACKED the moment a client pays for it.
 *
 * Origin (dev job e6136a5e, parent 8cc8e1c8 / PTBT): the installment handler
 * only created the tax_returns record in the branch that also created the
 * Tax Return SD — and even THAT insert had been failing silently since
 * inception (it omitted the NOT NULL company_name + deadline columns and the
 * per-step try/catch swallowed the violation). Result: 10 paid/active
 * clients had no record, were invisible to the season's extension batch,
 * and — after the 2026-07-16 eligibility gate made an OPEN record the
 * wizard's token — could never see their wizard.
 *
 * The renewal-year timeline this upholds (Antonio, 2026-07-17 — canonical):
 *   January   → renewal contract + 1st installment invoice. PAID ⇒ this
 *               helper creates the record ('Paid - Not Started'; client sees
 *               nothing — the SD parks pre-wizard).
 *   Season    → TD files extensions for ALL companies. The batch works off
 *               tax_returns rows, so January creation guarantees coverage;
 *               recording the batch advances each chain to "Extension Filed".
 *   June      → 2nd installment invoiced. PAID ⇒ the record is ensured
 *               ('Wizard Available') and the SD advance opens the wizard.
 *
 * Council-mandated invariants (5-reviewer pass, 2026-07-17):
 *  - company_name, deadline, data_received:false set EXPLICITLY (the token
 *    field must never ride a column default — the PTBT lesson).
 *  - Deadlines: MMLLC (1065) Mar 15; SMLLC (5472/1120) AND Corp (1120)
 *    Apr 15 — of the year after the tax year. Nominal dates (weekend/holiday
 *    shifts move them LATER, so stored values are conservative).
 *  - NULL formation_date FAILS CLOSED here (unlike the eligibility resolver,
 *    whose NULL-passes doctrine assumes a STAFF-deliberate row — an
 *    auto-created row carries no such deliberateness).
 *  - Existing rows are NEVER patched — a staff-set status/extension state
 *    outranks a payment event.
 *  - Race safety = the uq_tax_returns_account_year partial unique index
 *    (migration 20260717-1600) + the 23505 reselect below, NOT a retry loop
 *    (R098). Raw supabase call so the error code is visible (the db.ts
 *    wrappers discard it).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export type EnsureTaxReturnStatus = "Paid - Not Started" | "Wizard Available"

export interface EnsureTaxReturnParams {
  accountId: string
  companyName: string
  taxYear: number
  status: EnsureTaxReturnStatus
  memberStructure?: string | null
  entityType?: string | null
  formationDate?: string | null
  paid?: boolean
}

export interface EnsureTaxReturnResult {
  action: "created" | "exists" | "skipped_formation_guard" | "skipped_no_formation_date" | "error"
  id?: string
  /** True when the record was created after its nominal filing deadline —
   * the caller must alert staff to verify the extension (the season batch
   * could not have covered a row that didn't exist). */
  bornAfterDeadline?: boolean
  detail?: string
}

export function deriveReturnType(memberStructure?: string | null, entityType?: string | null): "SMLLC" | "MMLLC" | "Corp" {
  if (memberStructure === "multi_member") return "MMLLC"
  if ((entityType || "").toUpperCase().includes("CORP")) return "Corp"
  return "SMLLC"
}

/** Nominal filing deadline for the tax year: MMLLC (1065) Mar 15, SMLLC/Corp
 * (5472/1120) Apr 15 — of the following year. */
export function nominalDeadline(taxYear: number, returnType: "SMLLC" | "MMLLC" | "Corp"): string {
  return returnType === "MMLLC" ? `${taxYear + 1}-03-15` : `${taxYear + 1}-04-15`
}

export async function ensureTaxReturnRecord(p: EnsureTaxReturnParams): Promise<EnsureTaxReturnResult> {
  // Formation guard — Antonio's rule: no record for a year the company
  // didn't exist. NULL formation_date fails CLOSED on this auto path.
  if (!p.formationDate) {
    return { action: "skipped_no_formation_date", detail: "formation_date missing — record NOT auto-created; staff must set the date and create the season manually" }
  }
  const formationYear = new Date(p.formationDate).getFullYear()
  if (Number.isFinite(formationYear) && formationYear > p.taxYear) {
    return { action: "skipped_formation_guard", detail: `formed ${p.formationDate} — did not exist in ${p.taxYear}` }
  }

  const { data: existing, error: selErr } = await supabaseAdmin
    .from("tax_returns")
    .select("id")
    .eq("account_id", p.accountId)
    .eq("tax_year", p.taxYear)
    .limit(1)
    .maybeSingle()
  if (selErr) return { action: "error", detail: `lookup failed: ${selErr.message}` }
  if (existing) return { action: "exists", id: existing.id }

  const returnType = deriveReturnType(p.memberStructure, p.entityType)
  const deadline = nominalDeadline(p.taxYear, returnType)
  const today = new Date().toISOString().split("T")[0]

  // NOTE: tax_returns has NO paid_date column (verified 2026-07-17 — the old
  // inline insert referenced one, a THIRD reason it always failed).
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("tax_returns")
    .insert({
      account_id: p.accountId,
      company_name: p.companyName,
      return_type: returnType,
      tax_year: p.taxYear,
      status: p.status,
      deadline,
      data_received: false,
      paid: p.paid ?? true,
      notes: `Record auto-created by the installment chain on ${today} (renewal-chain fix, dev job e6136a5e).`,
    } as never)
    .select("id")
    .single()

  if (insErr) {
    // Unique violation = a concurrent creator won the race — the record
    // exists, which is exactly what "ensure" means.
    if (insErr.code === "23505") {
      const { data: raced } = await supabaseAdmin
        .from("tax_returns")
        .select("id")
        .eq("account_id", p.accountId)
        .eq("tax_year", p.taxYear)
        .limit(1)
        .maybeSingle()
      if (raced) return { action: "exists", id: raced.id, detail: "created concurrently" }
    }
    return { action: "error", detail: `insert failed: ${insErr.message}` }
  }

  return {
    action: "created",
    id: (inserted as { id: string }).id,
    bornAfterDeadline: deadline < today,
  }
}
