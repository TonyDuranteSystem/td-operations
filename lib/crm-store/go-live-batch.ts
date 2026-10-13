/**
 * Go live for MANY companies, one after another (the night run — master plan Part 33, dev job ad09ea91).
 * Each company is its own complete, self-checking operation (runGoLive): a company that fails any check is undone and
 * SKIPPED, the run goes on with the next, and the skipped ones are listed with the reason. Nothing here decides anything
 * new — it only walks the list, within a time budget, and reports.
 *
 * Only REAL attempts (a switch that took the lock) count toward the group size: a company that is simply not ready
 * (open signing, no finished copy …) is listed and passed over, so a few blocked companies can never starve the rest.
 * A company that was switched and then rolled back is not tried again by the night run (the owner retries it by hand).
 */

import { isExcludedCompany } from "./go-live"
import { chunksOf, sweepStaleGoLiveRuns, type GoLiveResult } from "./go-live-run"

export interface BatchCandidate { accountId: string; companyName: string }
export interface BatchOutcome { accountId: string; companyName: string; ok: boolean; message: string; repointed: number; attempted: boolean }
export interface BatchResult {
  /** switches that really started (took the lock) */
  attempted: number
  switched: number
  /** switched, not ready, or failed-and-undone — each listed with its reason */
  skipped: BatchOutcome[]
  switchedList: BatchOutcome[]
  /** companies not looked at because the group size or the time budget was reached — call again to continue */
  remaining: number
  outcomes: BatchOutcome[]
  sweptStuck?: number
}

export interface BatchDeps {
  candidates(): Promise<BatchCandidate[]>
  runOne(accountId: string, actorId: string): Promise<GoLiveResult>
  now(): number
}

/** Pure walk: start at most `limit` real switches; stop starting new ones when the budget is spent. A throw counts as "not ready". */
export async function walkBatch(actorId: string, opts: { limit: number; budgetMs: number }, deps: BatchDeps): Promise<BatchResult> {
  const list = await deps.candidates()
  const t0 = deps.now()
  const outcomes: BatchOutcome[] = []
  let attempted = 0
  let i = 0
  for (; i < list.length && attempted < opts.limit; i++) {
    if (deps.now() - t0 > opts.budgetMs) break
    const c = list[i]
    try {
      const r = await deps.runOne(c.accountId, actorId)
      const real = r.runId !== null
      if (real) attempted += 1
      outcomes.push({ accountId: c.accountId, companyName: c.companyName, ok: r.ok, message: r.message, repointed: r.repointed, attempted: real })
    } catch (e) {
      outcomes.push({ accountId: c.accountId, companyName: c.companyName, ok: false, message: e instanceof Error ? e.message : String(e), repointed: 0, attempted: false })
    }
  }
  return {
    attempted,
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
 * Companies still to switch: a hidden study copy with a finished copy run, an Active company (see isExcludedCompany), not
 * already switched-and-rolled-back by an earlier go-live run. Stable order (by name).
 */
export async function nightCandidates(): Promise<BatchCandidate[]> {
  const d = await db()
  const { data: owners, error } = await d.from("store_owners").select("id, account_id").eq("kind", "company").eq("study_only", true).not("account_id", "is", null)
  if (error) throw new Error(`Could not list the companies (${error.message}).`)
  const accountIds: string[] = (owners ?? []).map((o: { account_id: string }) => o.account_id)
  if (accountIds.length === 0) return []
  const accts: Array<{ id: string; company_name: string; status: string | null }> = []
  const skip = new Set<string>()
  for (const part of chunksOf(accountIds)) {
    const a = await d.from("accounts").select("id, company_name, status").in("id", part)
    if (a.error) throw new Error(`Could not read the companies (${a.error.message}).`)
    accts.push(...(a.data ?? []))
    const t = await d.from("store_import_runs").select("account_id").in("account_id", part).eq("mode", "move").eq("status", "rolled_back").filter("report->>goLive", "eq", "true")
    if (t.error) throw new Error(`Could not read the earlier switches (${t.error.message}).`)
    for (const r of (t.data ?? []) as Array<{ account_id: string }>) skip.add(r.account_id)
  }
  return accts
    .filter((a) => !skip.has(a.id) && !isExcludedCompany({ id: a.id, status: a.status, name: a.company_name }))
    .map((a) => ({ accountId: a.id, companyName: a.company_name }))
    .sort((x, y) => x.companyName.localeCompare(y.companyName))
}

export async function runNightBatch(actorId: string, opts: { limit?: number; budgetMs?: number } = {}): Promise<BatchResult> {
  const { runGoLive } = await import("./go-live-run")
  // a switch the platform killed earlier must not keep its company locked
  const swept = await sweepStaleGoLiveRuns(actorId).catch(() => ({ swept: 0, problems: [] as string[] }))
  const r = await walkBatch(actorId, { limit: opts.limit ?? 20, budgetMs: opts.budgetMs ?? 200_000 }, {
    candidates: nightCandidates,
    runOne: (accountId, actor) => runGoLive(accountId, actor),
    now: () => Date.now(),
  })
  return { ...r, sweptStuck: swept.swept }
}
