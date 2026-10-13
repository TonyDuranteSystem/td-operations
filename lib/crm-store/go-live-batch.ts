/**
 * Go live for MANY companies, one after another (the night run — master plan Part 33, dev job ad09ea91).
 * Each company is its own complete, self-checking operation (runGoLive): a company that fails any check is undone and
 * SKIPPED, the run goes on with the next, and the skipped ones are listed with the reason. Nothing here decides anything
 * new — it only walks the list, within a time budget, and reports.
 */

import { isExcludedCompany } from "./go-live"
import type { GoLiveResult } from "./go-live-run"

export interface BatchCandidate { accountId: string; companyName: string }
export interface BatchOutcome { accountId: string; companyName: string; ok: boolean; message: string; repointed: number }
export interface BatchResult {
  attempted: number
  switched: number
  skipped: BatchOutcome[]
  switchedList: BatchOutcome[]
  /** companies not tried because the time budget ran out — call again to continue */
  remaining: number
  outcomes: BatchOutcome[]
}

export interface BatchDeps {
  candidates(): Promise<BatchCandidate[]>
  runOne(accountId: string, actorId: string): Promise<GoLiveResult>
  now(): number
}

/** Pure walk: first `limit` candidates, stop starting new ones when the budget is spent. A throw counts as a skip. */
export async function walkBatch(actorId: string, opts: { limit: number; budgetMs: number }, deps: BatchDeps): Promise<BatchResult> {
  const list = await deps.candidates()
  const t0 = deps.now()
  const outcomes: BatchOutcome[] = []
  let i = 0
  for (; i < list.length && outcomes.length < opts.limit; i++) {
    if (deps.now() - t0 > opts.budgetMs) break
    const c = list[i]
    try {
      const r = await deps.runOne(c.accountId, actorId)
      outcomes.push({ accountId: c.accountId, companyName: c.companyName, ok: r.ok, message: r.message, repointed: r.repointed })
    } catch (e) {
      outcomes.push({ accountId: c.accountId, companyName: c.companyName, ok: false, message: e instanceof Error ? e.message : String(e), repointed: 0 })
    }
  }
  return {
    attempted: outcomes.length,
    switched: outcomes.filter((o) => o.ok).length,
    skipped: outcomes.filter((o) => !o.ok),
    switchedList: outcomes.filter((o) => o.ok),
    remaining: Math.max(0, list.length - i),
    outcomes,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types until production
async function db(): Promise<any> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  return supabaseAdmin
}

/**
 * Companies still to switch: a hidden study copy with a finished copy run, not already tried-and-skipped by an earlier pass
 * of this night (the run row of a rolled-back go-live is the memory), company still on Drive. Stable order (by name).
 */
export async function nightCandidates(): Promise<BatchCandidate[]> {
  const d = await db()
  const { data: owners, error } = await d.from("store_owners").select("id, account_id").eq("kind", "company").eq("study_only", true).not("account_id", "is", null)
  if (error) throw new Error(`Could not list the companies (${error.message}).`)
  const accountIds = (owners ?? []).map((o: { account_id: string }) => o.account_id)
  if (accountIds.length === 0) return []
  const { data: accts, error: aErr } = await d.from("accounts").select("id, company_name, status").in("id", accountIds)
  if (aErr) throw new Error(`Could not read the companies (${aErr.message}).`)
  const { data: tried } = await d.from("store_import_runs").select("account_id").in("account_id", accountIds).eq("mode", "move").eq("status", "rolled_back").filter("report->>goLive", "eq", "true")
  const skip = new Set((tried ?? []).map((t: { account_id: string }) => t.account_id))
  const out = (accts ?? [])
    .filter((a: { id: string; status: string | null; company_name: string }) => !skip.has(a.id) && !isExcludedCompany({ id: a.id, status: a.status, name: a.company_name }))
    .map((a: { id: string; company_name: string }) => ({ accountId: a.id, companyName: a.company_name }))
    .sort((x: BatchCandidate, y: BatchCandidate) => x.companyName.localeCompare(y.companyName))
  return out
}

export async function runNightBatch(actorId: string, opts: { limit?: number; budgetMs?: number } = {}): Promise<BatchResult> {
  const { runGoLive } = await import("./go-live-run")
  return walkBatch(actorId, { limit: opts.limit ?? 20, budgetMs: opts.budgetMs ?? 240_000 }, {
    candidates: nightCandidates,
    runOne: (accountId, actor) => runGoLive(accountId, actor),
    now: () => Date.now(),
  })
}
