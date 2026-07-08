/**
 * Books-path location answers (Phase B2, 2026-07-08) — the client twin of
 * `country-policy-sweep.ts::applyLocationAnswer`.
 *
 * Same five guard conditions as the workspace core, adapted to the books:
 *  (i)   eligible set recomputed server-side fresh — never transaction ids;
 *  (ii)  the UPDATE re-evaluates the full predicate itself (two atomic UPDATEs
 *        unioning to the NULL-safe manual guard — PostgREST PATCH-or() bug);
 *  (iii) 409-equivalent when the recomputed count/total differs from what the
 *        client's modal showed (`expected`);
 *  (iv)  N/A — books have no generated_at staleness concept (the review is
 *        computed on demand); TOCTOU is covered by (ii)+(iii);
 *  (v)   server-generated batch id; duplicate submit finds an empty eligible
 *        set → nothing_left.
 *
 * Differences from the workspace core, by design:
 *  - Scope is (account_id, tax_year) on `bank_transactions`.
 *  - The batch header row carries account_id + tax_year (workspace_id NULL —
 *    the dual-scope CHECK from migration 20260708-0300).
 *  - Prior state goes to `pnl_period_answer_book_rows` (transaction_id FKs to
 *    bank_transactions; the workspace rows table FKs to workspace txns).
 *  - A COUNTRY-scope answer also upserts the STANDING account policy
 *    (`account_location_policies`, provenance promoted_batch_id=batch) — that
 *    is what makes "answers are remembered next year" true for books answers:
 *    next year's workspace auto-sweep (S4) replays account policies. Undo of
 *    that batch deactivates the policy again.
 *  - Period answers write ZERO learned rules and ZERO policies (same rule as
 *    staff: "Glovo = business" was true for the travel period only).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { fetchAllPaged } from "@/lib/bank-transactions-fetch"
import { PERIOD_SWEEPABLE_CATEGORIES } from "./presence-periods"
import { LOCATION_ANSWER_SOURCES } from "./country-policy-sweep"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** NULL-safe "not manually answered" filter (same as the workspace core). */
const NOT_MANUAL_OR = "notes.is.null,notes.not.like.manual:%"

export interface ApplyBooksLocationAnswerInput {
  accountId: string
  taxYear: number
  locCodes: string[]
  choice: "business" | "personal"
  scope: "period" | "country"
  /** Required for scope 'period'; scope 'country' derives the full tax year. */
  periodStart?: string
  periodEnd?: string
  actorId: string
  actorRole: "staff" | "client"
  expected: { rowCount: number; dollarTotal: number } | null
}

export type ApplyBooksLocationAnswerResult =
  | { status: "count_mismatch"; fresh: { row_count: number; dollar_total: number } }
  | { status: "nothing_left" }
  | { status: "ok"; batchId: string; swept: number; skippedManual: number; skippedIneligible: number }

export async function applyBooksLocationAnswer(input: ApplyBooksLocationAnswerInput): Promise<ApplyBooksLocationAnswerResult> {
  const { accountId, taxYear, locCodes, choice, scope, actorId, actorRole, expected } = input
  const LOC_SOURCES = LOCATION_ANSWER_SOURCES[scope]

  let periodStart = input.periodStart ?? ""
  let periodEnd = input.periodEnd ?? ""
  if (scope === "country") {
    periodStart = `${taxYear}-01-01`
    periodEnd = `${taxYear}-12-31`
  }

  const base = () => db
    .from("bank_transactions")
    .select("id, amount, category, notes")
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
    .gte("transaction_date", periodStart)
    .lte("transaction_date", periodEnd)
    .in("loc_code", locCodes)
    .in("loc_source", LOC_SOURCES)
    .lt("amount", 0)

  const sweepable = [...PERIOD_SWEEPABLE_CATEGORIES]
  const candidates = await fetchAllPaged<{ id: string; amount: number | string; category: string; notes: string | null }>(async (from, to) => {
    const { data, error } = await base()
      .in("category", sweepable)
      .or(NOT_MANUAL_OR)
      .order("id", { ascending: true })
      .range(from, to)
    if (error) throw new Error(error.message)
    return (data ?? []) as Array<{ id: string; amount: number | string; category: string; notes: string | null }>
  })
  const { count: manualCount } = await db
    .from("bank_transactions")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
    .gte("transaction_date", periodStart)
    .lte("transaction_date", periodEnd)
    .in("loc_code", locCodes)
    .in("loc_source", LOC_SOURCES)
    .lt("amount", 0)
    .like("notes", "manual:%")
  const { count: locatedCount } = await db
    .from("bank_transactions")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
    .gte("transaction_date", periodStart)
    .lte("transaction_date", periodEnd)
    .in("loc_code", locCodes)
    .in("loc_source", LOC_SOURCES)
    .lt("amount", 0)

  const total = candidates.reduce((s, r) => s + Math.abs(Number(r.amount)), 0)
  if (expected && (candidates.length !== expected.rowCount || Math.abs(total - expected.dollarTotal) > 0.01)) {
    return { status: "count_mismatch", fresh: { row_count: candidates.length, dollar_total: total } }
  }
  if (candidates.length === 0) return { status: "nothing_left" }

  const target = choice === "business"
    ? { category: "expense", subcategory: "period_answer" }
    : { category: "distribution", subcategory: "personal_draw" }

  // Capture prior state (undo restore source), chunked.
  const prior: Array<{ id: string; category: string; subcategory: string | null; notes: string | null }> = []
  const candidateIds = candidates.map(c => c.id)
  for (let i = 0; i < candidateIds.length; i += 200) {
    const { data: preRows, error: preErr } = await db
      .from("bank_transactions")
      .select("id, category, subcategory, notes")
      .eq("account_id", accountId)
      .in("id", candidateIds.slice(i, i + 200))
    if (preErr) throw new Error(preErr.message)
    prior.push(...((preRows ?? []) as typeof prior))
  }

  const { data: header, error: headerErr } = await db
    .from("pnl_period_answers")
    .insert({
      account_id: accountId,
      tax_year: taxYear,
      loc_codes: locCodes,
      period_start: periodStart,
      period_end: periodEnd,
      choice,
      actor_id: actorId,
      actor_role: actorRole,
      row_count: candidates.length,
      dollar_total: total,
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
      const { error } = await db.from("pnl_period_answer_book_rows").insert(chunk)
      if (error) throw new Error(`Could not capture prior state: ${error.message}`)
    }

    const sweepBase = () => db
      .from("bank_transactions")
      .update({ ...target, notes: `manual: ${scope} answer ${batchId}` })
      .eq("account_id", accountId)
      .eq("tax_year", taxYear)
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

    const unswept = prior.filter(p => !sweptIds.has(p.id)).map(p => p.id)
    for (let i = 0; i < unswept.length; i += 500) {
      await db.from("pnl_period_answer_book_rows").delete().eq("batch_id", batchId).in("transaction_id", unswept.slice(i, i + 500))
    }
    const sweptTotal = swept.reduce((s, r) => s + Math.abs(Number(r.amount)), 0)
    await db.from("pnl_period_answers").update({ row_count: swept.length, dollar_total: sweptTotal }).eq("id", batchId)

    // COUNTRY answers become the STANDING account policy (next year's S4
    // auto-sweep replays it). Never fails the sweep.
    if (scope === "country") {
      try {
        for (const code of locCodes) {
          const { error } = await db
            .from("account_location_policies")
            .upsert({
              account_id: accountId,
              loc_code: code,
              choice,
              active: true,
              promoted_batch_id: batchId,
              created_by: actorId,
              updated_at: new Date().toISOString(),
            }, { onConflict: "account_id,loc_code" })
          if (error) throw new Error(error.message)
        }
      } catch (e) {
        console.error("[books-location-answer] policy upsert failed (sweep saved fine):", e)
      }
    }

    // Override telemetry (same precision meter as the workspace core).
    const changedOverrides = prior.filter(p =>
      sweptIds.has(p.id) && (p.notes ?? "").startsWith("ai:high") && p.category !== target.category)
    if (changedOverrides.length > 0) {
      try {
        await db.from("action_log").insert({
          actor: actorId,
          action_type: "ai_categorization_override",
          table_name: "bank_transactions",
          record_id: accountId,
          account_id: accountId,
          summary: `${actorRole === "client" ? "Client" : "Staff"} ${scope} answer (${choice}) changed ${changedOverrides.length} AI-booked row(s) → ${target.category}`,
          details: { account_id: accountId, tax_year: taxYear, batch_id: batchId, count: changedOverrides.length, from_categories: changedOverrides.map(o => o.category), to_category: target.category },
        })
      } catch (e) {
        console.error("[books-location-answer] override telemetry failed (sweep saved fine):", e)
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
    await db.from("pnl_period_answer_book_rows").delete().eq("batch_id", batchId)
    await db.from("pnl_period_answers").delete().eq("id", batchId)
    throw err
  }
}

export type UndoBooksLocationAnswerResult =
  | { status: "not_found" }
  | { status: "already_undone" }
  | { status: "ok"; restored: number; skippedReanswered: number }

/**
 * Reverse one books batch — exact per-row prior-state restore from
 * pnl_period_answer_book_rows. Rows re-answered AFTER the sweep are skipped
 * (the restore is guarded on the batch's own notes marker). Undoing a COUNTRY
 * batch also deactivates the standing policy it created.
 */
export async function undoBooksLocationAnswer(input: {
  accountId: string
  batchId: string
  actorId: string
}): Promise<UndoBooksLocationAnswerResult> {
  const { accountId, batchId, actorId } = input

  const { data: header } = await db
    .from("pnl_period_answers")
    .select("id, account_id, undone_at, loc_codes")
    .eq("id", batchId)
    .eq("account_id", accountId)
    .maybeSingle()
  if (!header) return { status: "not_found" }
  if (header.undone_at) return { status: "already_undone" }

  const batchRows = await fetchAllPaged<{ transaction_id: string; prev_category: string | null; prev_subcategory: string | null; prev_notes: string | null }>(async (from, to) => {
    const { data, error } = await db
      .from("pnl_period_answer_book_rows")
      .select("transaction_id, prev_category, prev_subcategory, prev_notes")
      .eq("batch_id", batchId)
      .order("transaction_id", { ascending: true })
      .range(from, to)
    if (error) throw new Error(error.message)
    return (data ?? []) as Array<{ transaction_id: string; prev_category: string | null; prev_subcategory: string | null; prev_notes: string | null }>
  })

  // Group by identical prior state → one guarded UPDATE per group (chunked).
  const groups = new Map<string, { category: string; subcategory: string | null; notes: string | null; ids: string[] }>()
  for (const r of batchRows) {
    const key = `${r.prev_category ?? "uncategorized"} ${r.prev_subcategory ?? ""} ${r.prev_notes ?? ""}`
    const g = groups.get(key) ?? { category: r.prev_category ?? "uncategorized", subcategory: r.prev_subcategory, notes: r.prev_notes, ids: [] }
    g.ids.push(r.transaction_id)
    groups.set(key, g)
  }

  let restored = 0
  for (const g of Array.from(groups.values())) {
    for (let i = 0; i < g.ids.length; i += 200) {
      const chunk = g.ids.slice(i, i + 200)
      const { data, error } = await db
        .from("bank_transactions")
        .update({ category: g.category, subcategory: g.subcategory, notes: g.notes })
        .eq("account_id", accountId)
        .in("id", chunk)
        .like("notes", `manual: % answer ${batchId}%`)
        .select("id")
      if (error) throw new Error(error.message)
      restored += (data ?? []).length
    }
  }

  await db.from("pnl_period_answers").update({ undone_at: new Date().toISOString() }).eq("id", batchId)

  // Deactivate any standing policy this batch created (country answers only —
  // period answers never write policies, the filter simply matches nothing).
  try {
    await db
      .from("account_location_policies")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("account_id", accountId)
      .eq("promoted_batch_id", batchId)
  } catch (e) {
    console.error("[books-location-answer] policy deactivation on undo failed:", e)
  }

  try {
    await db.from("action_log").insert({
      actor: actorId,
      action_type: "period_answer_undo",
      table_name: "bank_transactions",
      record_id: accountId,
      account_id: accountId,
      summary: `Undid books location answer ${batchId}: ${restored} row(s) restored`,
      details: { batch_id: batchId, restored, skipped_reanswered: batchRows.length - restored },
    })
  } catch (e) {
    console.error("[books-location-answer] undo audit failed:", e)
  }

  return { status: "ok", restored, skippedReanswered: batchRows.length - restored }
}
