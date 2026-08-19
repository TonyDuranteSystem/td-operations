/**
 * Country-policy sweep core (S4, 2026-07-06 — dual-adversarial-reviewed plan).
 *
 * ONE shared implementation of the location-answer sweep — the POST
 * period-answer route (interactive, staff click) and the country_policy_sweep
 * job (automatic replay of standing policies) both call `applyLocationAnswer`.
 * The predicate exists HERE and nowhere else: the S3 lesson (modal set ≡ swept
 * set, LOC_SOURCES in all query sites) survives only if there is a single
 * predicate to keep honest.
 *
 * Policy model:
 *  - A WORKSPACE policy is an active full-year country answer row in
 *    pnl_period_answers (human actor, undone_at IS NULL, policy_revoked_at IS
 *    NULL, period covering the whole tax year).
 *  - An ACCOUNT policy is an active account_location_policies row (promoted by
 *    Save-to-client) — the standing answer that replays on FUTURE years.
 *  - Resolution: the workspace's own answer outranks the account policy for the
 *    same country (freshest human intent wins); residence country is never
 *    swept (same exact-match suppression as the country-card builder).
 *  - Auto-swept batches are actor_role='system' and record WHICH policy they
 *    replayed; undoing one deactivates exactly that source (reviewer
 *    condition — otherwise the next chain-done re-sweeps the restored rows).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { fetchAllPaged } from "@/lib/bank-transactions-fetch"
import { PERIOD_SWEEPABLE_CATEGORIES } from "@/lib/tax/presence-periods"
import { residenceCountryToIso } from "@/lib/tax/merchant-locations"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** Scope-dependent location sources (S2/S3/F3): the period pipeline is
 *  deterministic-only end to end; country answers include AI-read places. */
export const LOCATION_ANSWER_SOURCES: Record<"period" | "country", string[]> = {
  period: ["text", "map"],
  country: ["text", "map", "ai"],
}

/** NULL-safe "not hand-answered" guard — PostgREST or() syntax. */
const NOT_MANUAL_OR = "notes.is.null,notes.not.like.manual:*"

export interface WorkspacePolicyRow {
  id: string
  loc_codes: string[]
  period_start: string
  period_end: string
  choice: string
  actor_role: string
  created_at: string
  undone_at: string | null
  policy_revoked_at: string | null
}

export interface AccountPolicyRow {
  id: string
  loc_code: string
  choice: string
  active: boolean
}

export interface ResolvedPolicy {
  loc_code: string
  choice: "business" | "personal"
  source: "workspace" | "account"
  /** pnl_period_answers.id (workspace) or account_location_policies.id (account). */
  source_id: string
}

/** Does this answer row cover the whole tax year (i.e. is it a policy)? */
export function isFullYearPolicyRow(row: Pick<WorkspacePolicyRow, "period_start" | "period_end">, taxYear: number): boolean {
  return row.period_start <= `${taxYear}-01-01` && row.period_end >= `${taxYear}-12-31`
}

/**
 * PURE policy resolution — unit-tested in isolation.
 * Workspace answers win over account policies per country; human actors only
 * (a system batch is a REPLAY, never itself a policy — self-reference would
 * loop); most recent workspace answer wins within a country; residence country
 * always dropped (exact match, parity with the country-card builder).
 */
export function resolveCountryPolicies(input: {
  workspaceAnswers: WorkspacePolicyRow[]
  accountPolicies: AccountPolicyRow[]
  taxYear: number
  residenceCountry: string | null
}): ResolvedPolicy[] {
  const byCode = new Map<string, ResolvedPolicy>()
  for (const p of input.accountPolicies) {
    if (!p.active) continue
    if (p.choice !== "business" && p.choice !== "personal") continue
    if (input.residenceCountry && p.loc_code === input.residenceCountry) continue
    byCode.set(p.loc_code, { loc_code: p.loc_code, choice: p.choice, source: "account", source_id: p.id })
  }
  const wsPolicies = input.workspaceAnswers
    .filter(a => a.actor_role === "staff" || a.actor_role === "client")
    .filter(a => !a.undone_at && !a.policy_revoked_at)
    .filter(a => isFullYearPolicyRow(a, input.taxYear))
    .filter(a => a.choice === "business" || a.choice === "personal")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1)) // newest first
  for (const a of wsPolicies) {
    for (const code of a.loc_codes) {
      if (input.residenceCountry && code === input.residenceCountry) continue
      if (byCode.get(code)?.source === "workspace") continue // newer ws answer already claimed it
      byCode.set(code, { loc_code: code, choice: a.choice as "business" | "personal", source: "workspace", source_id: a.id })
    }
  }
  return Array.from(byCode.values()).sort((a, b) => a.loc_code.localeCompare(b.loc_code))
}

/**
 * The linked client's declared fiscal-residence country (ISO). Null when
 * unknown. Also called from app/api/tools/pnl/[id]/route.ts (the staff P&L
 * workspace) rather than duplicating this resolution a second time.
 *
 * MEMBERS FIRST (2026-08-19): this used to scan every account_contacts row —
 * any role, any person linked to the account, not just owners — and returned
 * the first resolvable country in whatever order the query happened to
 * return. A non-owner (an authorized signer, a bookkeeper contact) could
 * decide the "home" country ahead of the actual member. Now it reads the
 * curated `members` table first, through the SAME whole-address resolver the
 * Operating Agreement uses (lib/members/member-address.ts) — so a
 * company-type member's country is always its OWN address.address_country,
 * never a representative's or a linked contact's (the exact Whalecot Consulting
 * defect fixed 2026-08-12: a company shown at its individual owner's personal
 * foreign address). The account_contacts scan is now a fallback for a
 * per-row gap — a member on file whose own address is blank — not just for
 * an account with zero curated members.
 */
export async function resolveAccountResidenceIso(accountId: string | null): Promise<string | null> {
  if (!accountId) return null

  const { resolveMemberAddress } = await import("@/lib/members/member-address")
  const { data: memberRows } = await db
    .from("members")
    .select("member_type, address_street, address_city, address_state, address_zip, address_country")
    .eq("account_id", accountId)
  for (const m of (memberRows ?? []) as Array<{ member_type: string | null; address_street: string | null; address_city: string | null; address_state: string | null; address_zip: string | null; address_country: string | null }>) {
    const iso = residenceCountryToIso(resolveMemberAddress(m).country)
    if (iso) return iso
  }

  // Fallback: no curated member resolved a country (no members on file, or
  // every member's own address is blank) — same broad scan as before.
  const { data: acRows } = await db
    .from("account_contacts")
    .select("contact_id")
    .eq("account_id", accountId)
  const contactIds = ((acRows ?? []) as Array<{ contact_id: string }>).map(r => r.contact_id)
  if (contactIds.length === 0) return null
  const { data: contactRows } = await db
    .from("contacts")
    .select("address_country")
    .in("id", contactIds)
  for (const c of (contactRows ?? []) as Array<{ address_country: string | null }>) {
    const iso = residenceCountryToIso(c.address_country)
    if (iso) return iso
  }
  return null
}

export interface ApplyLocationAnswerInput {
  workspaceId: string
  locCodes: string[]
  choice: "business" | "personal"
  scope: "period" | "country"
  /** Required for scope 'period'; scope 'country' derives the full tax year. */
  periodStart?: string
  periodEnd?: string
  actorId: string
  actorRole: "staff" | "client" | "system"
  /** Interactive confirm guard (iii) — what the modal displayed. Pass null on
   *  the automatic path (there is no modal; the eligible set IS the intent). */
  expected: { rowCount: number; dollarTotal: number } | null
  /** Auto-sweep provenance — which policy this batch replays. */
  sourcePolicyBatchId?: string | null
  sourceAccountPolicyId?: string | null
}

export type ApplyLocationAnswerResult =
  | { status: "not_found" }
  | { status: "no_tax_year" }
  | { status: "stale" }
  | { status: "count_mismatch"; fresh: { row_count: number; dollar_total: number } }
  | { status: "nothing_left" }
  | { status: "ok"; batchId: string; swept: number; skippedManual: number; skippedIneligible: number }

/**
 * The sweep core — guards → capture prior state → batch header + rows → two
 * atomic UPDATEs (the PostgREST PATCH-or() bug workaround, see the 2026-07-04
 * prod incident) → reconcile → telemetry. Behavior-identical to the pre-S4
 * route body; the only new inputs are actorRole 'system', expected:null and
 * the source-policy provenance columns.
 */
export async function applyLocationAnswer(input: ApplyLocationAnswerInput): Promise<ApplyLocationAnswerResult> {
  const { workspaceId, locCodes, choice, scope, actorId, actorRole, expected } = input
  const LOC_SOURCES = LOCATION_ANSWER_SOURCES[scope]

  const { data: wsRow } = await db
    .from("pnl_workspaces")
    .select("generated_at, tax_year")
    .eq("id", workspaceId)
    .maybeSingle()
  if (!wsRow) return { status: "not_found" }

  // Country scope: the range is ALWAYS the whole tax year, derived server-side.
  let periodStart = input.periodStart ?? ""
  let periodEnd = input.periodEnd ?? ""
  if (scope === "country") {
    const year = Number(wsRow.tax_year)
    if (!Number.isInteger(year)) return { status: "no_tax_year" }
    periodStart = `${year}-01-01`
    periodEnd = `${year}-12-31`
  }

  // Stale guard: new statements after generation = detection ran on incomplete
  // data — block (interactive) / skip (auto; the post-Regenerate chain re-runs).
  if (wsRow.generated_at) {
    const { data: newest } = await db
      .from("pnl_workspace_transactions")
      .select("created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (newest?.created_at && String(newest.created_at) > String(wsRow.generated_at)) {
      return { status: "stale" }
    }
  }

  // Guard (i): recompute the eligible set fresh. Same predicate as the UPDATE.
  const sweepable = [...PERIOD_SWEEPABLE_CATEGORIES]
  const candidates = await fetchAllPaged<{ id: string; amount: number | string; category: string; notes: string | null }>(async (from, to) => {
    const { data, error } = await db
      .from("pnl_workspace_transactions")
      .select("id, amount, category, notes")
      .eq("workspace_id", workspaceId)
      .gte("transaction_date", periodStart)
      .lte("transaction_date", periodEnd)
      .in("loc_code", locCodes)
      .in("loc_source", LOC_SOURCES)
      .lt("amount", 0)
      .in("category", sweepable)
      .or(NOT_MANUAL_OR)
      .order("id", { ascending: true })
      .range(from, to)
    if (error) throw new Error(error.message)
    return (data ?? []) as Array<{ id: string; amount: number | string; category: string; notes: string | null }>
  })
  // Honest skip counts (engineer cond. 7 / Slice 7c pattern).
  const { count: manualCount } = await db
    .from("pnl_workspace_transactions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .gte("transaction_date", periodStart)
    .lte("transaction_date", periodEnd)
    .in("loc_code", locCodes)
    .in("loc_source", LOC_SOURCES)
    .lt("amount", 0)
    .like("notes", "manual:%")
  const { count: locatedCount } = await db
    .from("pnl_workspace_transactions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .gte("transaction_date", periodStart)
    .lte("transaction_date", periodEnd)
    .in("loc_code", locCodes)
    .in("loc_source", LOC_SOURCES)
    .lt("amount", 0)

  const total = candidates.reduce((s, r) => s + Math.abs(Number(r.amount)), 0)
  // Guard (iii), interactive only: the user confirmed exactly this set.
  if (expected && (candidates.length !== expected.rowCount || Math.abs(total - expected.dollarTotal) > 0.01)) {
    return { status: "count_mismatch", fresh: { row_count: candidates.length, dollar_total: total } }
  }
  if (candidates.length === 0) return { status: "nothing_left" }

  const target = choice === "business"
    ? { category: "expense", subcategory: "period_answer" } // ai_bucket untouched — breakdown reads it
    : { category: "distribution", subcategory: "personal_draw" }

  // Capture prior state (undo restore source), CHUNKED (the 957-row/URL-length
  // prod incident).
  const prior: Array<{ id: string; category: string; subcategory: string | null; notes: string | null }> = []
  const candidateIds = candidates.map(c => c.id)
  for (let i = 0; i < candidateIds.length; i += 200) {
    const { data: preRows, error: preErr } = await db
      .from("pnl_workspace_transactions")
      .select("id, category, subcategory, notes")
      .eq("workspace_id", workspaceId)
      .in("id", candidateIds.slice(i, i + 200))
    if (preErr) throw new Error(preErr.message)
    prior.push(...((preRows ?? []) as typeof prior))
  }

  // Batch header + rows BEFORE the sweep (a swept row without restore data must
  // be impossible; captured-but-unswept reconciles away).
  const { data: header, error: headerErr } = await db
    .from("pnl_period_answers")
    .insert({
      workspace_id: workspaceId,
      loc_codes: locCodes,
      period_start: periodStart,
      period_end: periodEnd,
      choice,
      actor_id: actorId,
      actor_role: actorRole,
      row_count: candidates.length,
      dollar_total: total,
      // Provenance keys only when set — the interactive path stays independent
      // of the S4 DDL (PostgREST errors on unknown columns, even null ones).
      ...(input.sourcePolicyBatchId ? { source_policy_batch_id: input.sourcePolicyBatchId } : {}),
      ...(input.sourceAccountPolicyId ? { source_account_policy_id: input.sourceAccountPolicyId } : {}),
    })
    .select("id")
    .single()
  if (headerErr || !header) throw new Error(`Could not create the period-answer record: ${headerErr?.message}`)
  const batchId = header.id as string

  try {
    for (let i = 0; i < prior.length; i += 500) {
      const chunk = prior.slice(i, i + 500).map(p => ({
        batch_id: batchId,
        transaction_id: p.id,
        prev_category: p.category,
        prev_subcategory: p.subcategory,
        prev_notes: p.notes,
      }))
      const { error } = await db.from("pnl_period_answer_rows").insert(chunk)
      if (error) throw new Error(`Could not capture prior state: ${error.message}`)
    }

    // Guard (ii): the sweep re-evaluates the whole predicate on the UPDATE.
    // TWO atomic UPDATEs whose simple filters union to the exact NULL-safe
    // predicate — production PostgREST rejects `or=` on PATCH (2026-07-04).
    const sweepBase = () => db
      .from("pnl_workspace_transactions")
      .update({ ...target, notes: `manual: ${scope} answer ${batchId}` })
      .eq("workspace_id", workspaceId)
      .gte("transaction_date", periodStart)
      .lte("transaction_date", periodEnd)
      .in("loc_code", locCodes)
      .in("loc_source", LOC_SOURCES)
      .lt("amount", 0)
      .in("category", sweepable)
    const { data: sweptNull, error: err1 } = await sweepBase().is("notes", null).select("id, amount")
    if (err1) throw new Error(err1.message)
    const { data: sweptRest, error: err2 } = await sweepBase().not("notes", "like", "manual:%").select("id, amount")
    if (err2) throw new Error(err2.message)
    const swept = ([...(sweptNull ?? []), ...(sweptRest ?? [])]) as Array<{ id: string; amount: number | string }>
    const sweptIds = new Set(swept.map(r => r.id))

    // Reconcile: drop captured-but-unswept rows, stamp ACTUAL counts.
    const unswept = prior.filter(p => !sweptIds.has(p.id)).map(p => p.id)
    for (let i = 0; i < unswept.length; i += 500) {
      await db.from("pnl_period_answer_rows").delete().eq("batch_id", batchId).in("transaction_id", unswept.slice(i, i + 500))
    }
    const sweptTotal = swept.reduce((s, r) => s + Math.abs(Number(r.amount)), 0)
    await db.from("pnl_period_answers").update({ row_count: swept.length, dollar_total: sweptTotal }).eq("id", batchId)

    // Override telemetry — the production precision meter.
    const changedOverrides = prior.filter(p =>
      sweptIds.has(p.id) && (p.notes ?? "").startsWith("ai:high") && p.category !== target.category)
    if (changedOverrides.length > 0) {
      try {
        await db.from("action_log").insert({
          actor: actorId,
          action_type: "ai_categorization_override",
          table_name: "pnl_workspace_transactions",
          record_id: workspaceId,
          summary: `${actorRole === "system" ? "Country-policy auto-sweep" : "Period answer"} (${choice}) changed ${changedOverrides.length} AI-booked row(s) → ${target.category}`,
          details: { workspace_id: workspaceId, batch_id: batchId, count: changedOverrides.length, from_categories: changedOverrides.map(o => o.category), to_category: target.category, ai_versions: Array.from(new Set(changedOverrides.map(o => o.notes))) },
        })
      } catch (e) {
        console.error("[country-policy-sweep] override telemetry failed (sweep saved fine):", e)
      }
    }

    return {
      status: "ok",
      batchId,
      swept: swept.length,
      skippedManual: manualCount ?? 0,
      skippedIneligible: Math.max(0, (locatedCount ?? 0) - (manualCount ?? 0) - candidates.length),
    }
  } catch (err) {
    // Void the batch so a failed sweep never leaves a half-batch behind.
    await db.from("pnl_period_answer_rows").delete().eq("batch_id", batchId)
    await db.from("pnl_period_answers").delete().eq("id", batchId)
    throw err
  }
}

export interface CountryPolicySweepSummary {
  policies: number
  sweeps: Array<{ loc_code: string; choice: string; source: string; status: string; swept?: number; batch_id?: string }>
  /** True when the workspace was stale or missing — nothing attempted. */
  skippedAll: boolean
  reason?: string
}

/**
 * Replay every active country policy on a workspace — the S4 auto-sweep.
 * Runs at AI-chain completion (country_policy_sweep job). "Nothing to do" is
 * SUCCESS, never failure (the 2026-07-05 lesson). Every booked batch is
 * actor_role='system' with provenance, exact-undoable, and audit-logged.
 */
export async function runCountryPolicySweep(workspaceId: string): Promise<CountryPolicySweepSummary> {
  const { data: ws } = await db
    .from("pnl_workspaces")
    .select("id, tax_year, linked_account_id")
    .eq("id", workspaceId)
    .maybeSingle()
  if (!ws) return { policies: 0, sweeps: [], skippedAll: true, reason: "workspace not found" }
  const taxYear = Number(ws.tax_year)
  if (!Number.isInteger(taxYear)) return { policies: 0, sweeps: [], skippedAll: true, reason: "no tax year" }

  const { data: wsAnswerRows } = await db
    .from("pnl_period_answers")
    .select("id, loc_codes, period_start, period_end, choice, actor_role, created_at, undone_at, policy_revoked_at")
    .eq("workspace_id", workspaceId)
  const { data: acctPolicyRows } = ws.linked_account_id
    ? await db
      .from("account_location_policies")
      .select("id, loc_code, choice, active")
      .eq("account_id", ws.linked_account_id)
      .eq("active", true)
    : { data: [] }

  const residenceCountry = await resolveAccountResidenceIso(ws.linked_account_id ?? null)
  const policies = resolveCountryPolicies({
    workspaceAnswers: (wsAnswerRows ?? []) as WorkspacePolicyRow[],
    accountPolicies: (acctPolicyRows ?? []) as AccountPolicyRow[],
    taxYear,
    residenceCountry,
  })

  const summary: CountryPolicySweepSummary = { policies: policies.length, sweeps: [], skippedAll: false }
  for (const p of policies) {
    const r = await applyLocationAnswer({
      workspaceId,
      locCodes: [p.loc_code],
      choice: p.choice,
      scope: "country",
      actorId: `system:policy:${p.source}`,
      actorRole: "system",
      expected: null,
      sourcePolicyBatchId: p.source === "workspace" ? p.source_id : null,
      sourceAccountPolicyId: p.source === "account" ? p.source_id : null,
    })
    summary.sweeps.push({
      loc_code: p.loc_code,
      choice: p.choice,
      source: p.source,
      status: r.status,
      swept: r.status === "ok" ? r.swept : undefined,
      batch_id: r.status === "ok" ? r.batchId : undefined,
    })
    // Stale workspace: stop — every remaining country would return the same.
    if (r.status === "stale") {
      summary.skippedAll = summary.sweeps.every(s => s.status === "stale")
      summary.reason = "workspace stale — Regenerate will re-run the chain and this sweep"
      break
    }
    // Audit every automatic booking (architect condition: automation must be
    // loudly visible, not just undoable).
    if (r.status === "ok" && r.swept > 0) {
      try {
        await db.from("action_log").insert({
          actor: "system:country-policy-sweep",
          action_type: "pnl_country_policy_autosweep",
          table_name: "pnl_workspace_transactions",
          record_id: workspaceId,
          summary: `Auto-booked ${r.swept} row(s) in ${p.loc_code} as ${p.choice} under the standing ${p.source} policy`,
          details: { workspace_id: workspaceId, batch_id: r.batchId, loc_code: p.loc_code, choice: p.choice, policy_source: p.source, policy_id: p.source_id },
        })
      } catch (e) {
        console.error("[country-policy-sweep] audit insert failed (sweep saved fine):", e)
      }
    }
  }
  return summary
}
