/**
 * THE PRODUCTION CONTRACT MONITOR.
 *
 * Runs inside the app, against the database the app is actually deployed against, and answers
 * two questions the push-time gate structurally cannot:
 *
 *   1. Does PRODUCTION still accept every value the deployed code can write?
 *      (The push gate compares the code to a committed snapshot. If the snapshot is stale, it
 *      is comparing the code to fiction.)
 *
 *   2. Has production drifted from the committed snapshot?
 *      Production DDL here is applied BY HAND in the Supabase dashboard. That is not a push
 *      event, so no push-time gate — CI included — can see it. Only something that looks at the
 *      live database can. This is that something.
 *
 * It needs NO new credential: the app already holds a legitimate service-role client for the
 * database it is deployed against, and production exposes `exec_sql_readonly`. Inventing a
 * second way in (a Postgres password in CI) would have added an exposure surface to learn the
 * same fact.
 *
 * ── WHERE THE ALARM GOES, AND WHY IT IS NOT JUST /system-health ──
 *
 * It raises a job on the DEV BOARD. A row on a status page is a note: someone has to choose to
 * open the page. Nothing obliges them to. The dev board prints at the start of every session —
 * it is in front of the work, not beside it. Given the entire incident was "a signal nobody was
 * forced to look at", routing this alarm to another page-you-must-remember-to-visit would have
 * been the same mistake wearing a fresh coat.
 *
 * It ALSO writes a system_errors row, so it shows up on /system-health for whoever is looking
 * there. Both, not either.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { reportSystemError } from "@/lib/system-errors"
import { checkDbContract, diffAgainstSnapshot, type ContractViolation, type SnapshotDrift } from "@/lib/db-contract"
import { prodConstraints, prodSnapshotMeta, verifySnapshotIntegrity } from "@/lib/db-contract-snapshot"
import { readLiveConstraints } from "@/lib/db-contract-read"

const PRODUCTION_REF = "ydzipybqeebtpcvsbtvs"
const DEV_TASK_TITLE = "DB contract drift — code and production disagree"

export interface ContractMonitorResult {
  ran: boolean
  /** Why it did not run (not production, read failed, …). */
  skipped?: string
  liveConstraintCount?: number
  violations: ContractViolation[]
  drift: SnapshotDrift[]
  /** Whether an alarm was raised (dev-board job + system_errors row). */
  alarmed: boolean
  error?: string
}

function isProduction(): boolean {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL || "").includes(PRODUCTION_REF)
}

/**
 * Raise the alarm on the dev board — creating the job, or refreshing the one already open.
 *
 * R053: never insert a second job for the same topic. The monitor runs daily; a fresh row every
 * day would bury the board and train everyone to ignore it, which is how a loud alarm becomes a
 * quiet one.
 */
async function raiseDevBoardJob(summary: string, detail: string): Promise<void> {
  const { data: existing, error: selErr } = await supabaseAdmin
    .from("dev_tasks")
    .select("id, progress_log")
    .eq("title", DEV_TASK_TITLE)
    .in("status", ["todo", "in_progress", "blocked", "backlog"])
    .maybeSingle()

  if (selErr) throw new Error(`dev_tasks lookup failed: ${selErr.message}`)

  const today = new Date().toISOString().slice(0, 10)

  if (existing) {
    const { error } = await supabaseAdmin
      .from("dev_tasks")
      .update({
        findings: detail,
        summary_plain: summary,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
    if (error) throw new Error(`dev_tasks refresh failed: ${error.message}`)
    return
  }

  const { error } = await supabaseAdmin.from("dev_tasks").insert({
    title: DEV_TASK_TITLE,
    channel: "td-bug",
    type: "infra",
    status: "todo",
    priority: "critical",
    summary_plain: summary,
    description:
      "The daily contract monitor found that the code and the LIVE production database no longer " +
      "agree about what values are allowed in a constrained column.\n\n" +
      "This matters because a rejected write does not shout — it returns an error that the caller " +
      "may discard, and the feature silently does nothing. That is exactly how the bank-feed review " +
      "queue stayed empty for months.\n\n" +
      "Fix by making the DATABASE and the CODE agree (a migration, or a code change), then " +
      "regenerate the committed snapshot: npm run snapshot:constraints",
    findings: detail,
    progress_log: JSON.stringify([
      { date: today, action: "Contract monitor detected drift", result: summary },
    ]),
  })
  if (error) throw new Error(`dev_tasks insert failed: ${error.message}`)
}

/**
 * Compare the deployed code + committed snapshot against the LIVE database.
 *
 * @param opts.dryRun  Compare and return, but raise no alarm. Used to exercise the real path in
 *                     sandbox — a monitor whose alarm path has never run is a monitor you are
 *                     merely hoping works.
 * @param opts.force   Run even when this is not production (for the same reason).
 */
export async function runContractMonitor(
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<ContractMonitorResult> {
  const empty: ContractMonitorResult = { ran: false, violations: [], drift: [], alarmed: false }

  if (!isProduction() && !opts.force) {
    // Outside production, drift against the production snapshot is EXPECTED (sandbox carries
    // dev-only tables). Alarming on it would produce a daily false positive, and a daily false
    // positive is how a real alarm gets ignored.
    return { ...empty, skipped: "not production" }
  }

  // The snapshot must be honest before anything is compared to it.
  const integrity = verifySnapshotIntegrity()
  if (!integrity.ok) {
    const summary = "The committed database snapshot has been hand-edited and no longer matches its own checksum."
    if (!opts.dryRun) {
      await reportSystemError({
        source: "server",
        route: "cron/db-contract-monitor",
        message: `DB contract snapshot integrity failure: ${integrity.reason}`,
      })
      await raiseDevBoardJob(summary, integrity.reason)
    }
    return { ...empty, ran: true, alarmed: !opts.dryRun, error: integrity.reason }
  }

  let live
  try {
    live = await readLiveConstraints(supabaseAdmin)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // A read that failed is NOT a clean bill of health. Say so loudly rather than returning
    // "no violations" — reporting a state we could not observe is the original sin here.
    if (!opts.dryRun) {
      await reportSystemError({
        source: "server",
        route: "cron/db-contract-monitor",
        message: `Could not read production's constraints — the contract is UNVERIFIED: ${message}`,
      })
    }
    return { ...empty, ran: true, alarmed: !opts.dryRun, error: message }
  }

  const { violations } = checkDbContract(live)
  const drift = diffAgainstSnapshot(live, prodConstraints())

  if (violations.length === 0 && drift.length === 0) {
    return { ran: true, liveConstraintCount: Object.keys(live).length, violations: [], drift: [], alarmed: false }
  }

  // ── Something disagrees. Say what, in words a human can act on. ──
  const lines: string[] = []

  if (violations.length > 0) {
    lines.push(`THE CODE CAN WRITE VALUES PRODUCTION REJECTS (${violations.length}):`)
    for (const v of violations) lines.push(`  • ${v.message}`)
    lines.push("")
  }

  if (drift.length > 0) {
    const meta = prodSnapshotMeta()
    lines.push(`PRODUCTION HAS CHANGED SINCE THE SNAPSHOT WAS TAKEN (${meta.generatedAt}) — ${drift.length} difference(s):`)
    for (const d of drift.slice(0, 25)) lines.push(`  • ${d.message}`)
    if (drift.length > 25) lines.push(`  … and ${drift.length - 25} more.`)
    lines.push("")
    lines.push("Until the snapshot is regenerated, the push-time gate is checking the code against a")
    lines.push("stale copy of production's rules. Run: npm run snapshot:constraints")
  }

  const detail = lines.join("\n")

  const summary =
    violations.length > 0
      ? `The code can write ${violations.length} value(s) that production will reject — those writes fail silently.`
      : `Production's database rules changed by hand; the copy the push-gate checks against is now stale.`

  if (!opts.dryRun) {
    await reportSystemError({
      source: "server",
      route: "cron/db-contract-monitor",
      message: `DB contract: ${violations.length} violation(s), ${drift.length} snapshot drift(s)`,
      context: {
        violations: violations.map(v => ({ kind: v.kind, constraint: v.constraint, rejected: v.rejectedValues })),
        drift: drift.map(d => ({ kind: d.kind, constraint: d.constraint })),
      },
    })
    await raiseDevBoardJob(summary, detail)
  }

  return {
    ran: true,
    liveConstraintCount: Object.keys(live).length,
    violations,
    drift,
    alarmed: !opts.dryRun,
  }
}
