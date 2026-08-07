/**
 * One-click apply for renewal problem fixes (plan 89c951a7).
 *
 * Safety contract (council-hardened):
 *  1. NEVER trust the card — recompute the company's live status and
 *     re-derive the proposal server-side; the click is only valid if the
 *     freshly-derived auto-fix EXACTLY matches what the card showed
 *     (column/from/to). A stale card fails loudly with a refresh message.
 *  2. Checked write — the UPDATE carries the expected current value
 *     (.eq/.is on `from`), so a concurrent change loses nothing.
 *  3. Deadlines mirror + action_log audit row in the same operation.
 *  4. Returns the RECOMPUTED status after the write — the flag only clears
 *     because the engine now says the company is clean, never because a
 *     write "succeeded".
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { loadRenewalStatuses } from "@/lib/operations/renewal-status-loader"
import { proposeRenewalFixes, type RenewalAutoFix, type ProposalAction } from "@/lib/operations/renewal-problem-proposals"
import { mirrorDeadlineDate } from "@/lib/operations/renewal-dates"
import type { ObligationKind, CompanyRenewalStatus } from "@/lib/operations/renewal-status"

export interface ApplyAutoFixRequest {
  accountId: string
  obligation: ObligationKind
  action: ProposalAction
  /** The auto-fix exactly as rendered on the card the user clicked. */
  autoFix: RenewalAutoFix
  /** Dashboard user applying the fix (audit trail). */
  actor: string
}

export type ApplyAutoFixResult =
  | { ok: true; applied: string; status: CompanyRenewalStatus }
  | { ok: false; error: string }

const AUTO_FIXABLE: ProposalAction[] = ["roll_forward_date", "derive_missing_date"]

export async function applyRenewalAutoFix(req: ApplyAutoFixRequest): Promise<ApplyAutoFixResult> {
  if (!AUTO_FIXABLE.includes(req.action)) {
    return { ok: false, error: `Action "${req.action}" has no one-click fix — follow the card's instructions instead.` }
  }

  // 1. Recompute live and re-derive the proposal — the card is a claim, not a fact.
  const loadedRows = await loadRenewalStatuses(supabaseAdmin, { accountIds: [req.accountId] })
  const loaded = loadedRows[0]
  if (!loaded) {
    return { ok: false, error: "Company not found among active accounts — refresh the calendar." }
  }
  const proposal = proposeRenewalFixes(loaded).find(p => p.obligation === req.obligation)
  const fresh = proposal?.autoFix ?? null
  if (
    !proposal ||
    proposal.action !== req.action ||
    !fresh ||
    fresh.column !== req.autoFix.column ||
    fresh.from !== req.autoFix.from ||
    fresh.to !== req.autoFix.to
  ) {
    return {
      ok: false,
      error: "This record changed since the card was shown — refresh the calendar and re-check the problem.",
    }
  }

  // 2. Checked write: the column must still hold exactly the value the card showed.
  // eslint-disable-next-line no-restricted-syntax -- calendar record repair; revalidated + checked write (plan 89c951a7)
  let update = supabaseAdmin
    .from("accounts")
    .update({ [fresh.column]: fresh.to, updated_at: new Date().toISOString() })
    .eq("id", req.accountId)
  update = fresh.from === null ? update.is(fresh.column, null) : update.eq(fresh.column, fresh.from)
  const { data: written, error: writeError } = await update.select("id")
  if (writeError) {
    return { ok: false, error: `Could not update the record: ${writeError.message}` }
  }
  if (!written?.length) {
    return { ok: false, error: "The record changed while applying — nothing was written. Refresh and re-check." }
  }

  // 3. Deadlines mirror (best-effort) + audit row.
  const deadlineType = req.obligation === "ra_renewal" ? "RA Renewal" : "Annual Report"
  try {
    await mirrorDeadlineDate(req.accountId, deadlineType, fresh.to, {
      state: loaded.account.state_of_formation,
      note: `Calendar one-click fix (${req.action}) by ${req.actor}`,
      // A rolled record's open deadline row still carries the OLD cycle's year.
      matchYear: fresh.from ? new Date(fresh.from).getFullYear() : undefined,
    })
  } catch {
    // mirror is best-effort; the account date above is the source of truth
  }
  await supabaseAdmin.from("action_log").insert({
    actor: req.actor,
    action_type: "renewal_record_fix",
    table_name: "accounts",
    record_id: req.accountId,
    account_id: req.accountId,
    summary: `${proposal.summary} — ${fresh.column}: ${fresh.from ?? "(empty)"} → ${fresh.to} (${req.action})`,
    details: {
      action: req.action,
      obligation: req.obligation,
      column: fresh.column,
      from: fresh.from,
      to: fresh.to,
      proposal_summary: proposal.summary,
      proposal_details: proposal.details,
      applied_by: req.actor,
    },
  })

  // 4. The flag clears only if a clean recompute says so.
  const after = await loadRenewalStatuses(supabaseAdmin, { accountIds: [req.accountId] })
  const status = after[0]?.status ?? loaded.status
  return { ok: true, applied: `${fresh.column} → ${fresh.to}`, status }
}
