/**
 * Tax-form completion sweep — safety net for the external tax form's
 * post-completion chain.
 *
 * The chain (/api/tax-form-completed: team email, review dispatch, What's New
 * card, review_status marker, Drive save, P&L) is triggered from the client's
 * browser fire-and-forget; a failed call is invisible. This cron re-fires the
 * chain server-side for external submissions whose marker never got written
 * (see lib/tax/completion-sweep.ts for the predicate and its invariant).
 *
 * Safety posture:
 * - DRY-RUN BY DEFAULT: fires nothing until TAX_COMPLETION_SWEEP_DRY_RUN is
 *   set to the string "false" (prod goes live deliberately; sandbox stays
 *   report-only forever unless someone opts it in).
 * - Per-row attempt counter in financials_meta, incremented BEFORE each fire
 *   so a crash mid-fire still counts; after SWEEP_MAX_ATTEMPTS the row is
 *   alert-only (each fire can resend the internal team email).
 * - review_status re-checked immediately before each fire (a direct fire may
 *   have landed since the candidate query).
 * - Target URL via getInternalBaseUrl() — never a hardcoded production host,
 *   so the sandbox project's cron talks to the sandbox deployment.
 * - Success = the response's review_status step reported ok (the route always
 *   answers HTTP 200, even when steps inside failed).
 */
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { reportSystemError } from "@/lib/system-errors"
import { getInternalBaseUrl } from "@/lib/mcp/tools/agent-messages"
import { postTeamMessage } from "@/lib/team/post-message"
import {
  formatSweepAlert,
  isSweepEligible,
  parseChainResults,
  sweepAttempts,
  SWEEP_ALERT_CHANNEL,
  SWEEP_ALERTED_KEY,
  SWEEP_ATTEMPTS_KEY,
  SWEEP_CUTOFF_ISO,
  SWEEP_MAX_ATTEMPTS,
  SWEEP_MAX_FIRES_PER_RUN,
  type SweepAlertItem,
} from "@/lib/tax/completion-sweep"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const ENDPOINT = "/api/cron/tax-completion-sweep"
const PER_FIRE_TIMEOUT_MS = 75_000

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const dryRun = process.env.TAX_COMPLETION_SWEEP_DRY_RUN !== "false"
  const now = new Date()
  const outcomes: { submission_id: string; token: string | null; outcome: string; detail?: string }[] = []
  // Rows to announce in the ⚠️ team-chat alert this run, and rows to stamp
  // with the alerted marker afterwards (so watch-mode candidates and gave-up
  // rows alert ONCE, not every 30 minutes).
  const alertItems: (SweepAlertItem & { submission_id: string })[] = []
  const markAlerted: { id: string; meta: Record<string, unknown> }[] = []

  try {
    const { data: rows, error } = await supabaseAdmin
      .from("tax_return_submissions")
      .select("id, token, account_id, tax_year, status, completed_at, review_status, financials_meta")
      .eq("status", "completed")
      .is("review_status", null)
      .gte("completed_at", SWEEP_CUTOFF_ISO)
      .order("completed_at", { ascending: true })
      .limit(25)

    if (error) throw new Error(`candidate query failed: ${error.message}`)

    const eligible = (rows ?? []).filter(r => isSweepEligible(r, now))

    const companyNames = new Map<string, string>()
    const accountIds = Array.from(new Set(eligible.map(r => r.account_id).filter(Boolean))) as string[]
    if (accountIds.length > 0) {
      const { data: accounts } = await supabaseAdmin
        .from("accounts")
        .select("id, company_name")
        .in("id", accountIds)
      for (const a of accounts ?? []) companyNames.set(a.id, a.company_name)
    }
    const companyOf = (row: { account_id: string | null; token: string | null }) =>
      (row.account_id && companyNames.get(row.account_id)) || row.token || "unknown submission"

    if (dryRun) {
      for (const row of eligible) {
        outcomes.push({ submission_id: row.id, token: row.token, outcome: "dry_run_candidate" })
        const meta = (row.financials_meta ?? {}) as Record<string, unknown>
        if (!meta[SWEEP_ALERTED_KEY]) {
          alertItems.push({ submission_id: row.id, company: companyOf(row), tax_year: row.tax_year, outcome: "dry_run_candidate" })
          markAlerted.push({ id: row.id, meta })
        }
      }
    } else {
      for (const row of eligible.slice(0, SWEEP_MAX_FIRES_PER_RUN)) {
        const meta = (row.financials_meta ?? {}) as Record<string, unknown>
        const attempts = sweepAttempts(meta)

        if (attempts >= SWEEP_MAX_ATTEMPTS) {
          outcomes.push({ submission_id: row.id, token: row.token, outcome: "gave_up", detail: `${attempts} attempts` })
          if (!meta[SWEEP_ALERTED_KEY]) {
            alertItems.push({ submission_id: row.id, company: companyOf(row), tax_year: row.tax_year, outcome: "gave_up" })
            markAlerted.push({ id: row.id, meta })
          }
          await reportSystemError({
            source: "server",
            route: ENDPOINT,
            message: "Tax completion sweep gave up on a submission — chain marker still missing after max attempts, needs a human",
            context: { submission_id: row.id, token: row.token, attempts },
          })
          continue
        }

        // Direct fire may have landed between the candidate query and now.
        const { data: fresh } = await supabaseAdmin
          .from("tax_return_submissions")
          .select("review_status")
          .eq("id", row.id)
          .single()
        if (fresh?.review_status != null) {
          outcomes.push({ submission_id: row.id, token: row.token, outcome: "skipped_marker_appeared" })
          continue
        }

        // Count the fire before making it, so a crash mid-fire still counts.
        await supabaseAdmin
          .from("tax_return_submissions")
          .update({ financials_meta: { ...meta, [SWEEP_ATTEMPTS_KEY]: attempts + 1 } })
          .eq("id", row.id)

        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), PER_FIRE_TIMEOUT_MS)
          const res = await fetch(`${getInternalBaseUrl()}/api/tax-form-completed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ submission_id: row.id, token: row.token }),
            signal: controller.signal,
          })
          clearTimeout(timer)
          const body = await res.json().catch(() => null)
          const { markerOk, errorSteps } = parseChainResults(body)

          if (markerOk) {
            outcomes.push({
              submission_id: row.id,
              token: row.token,
              outcome: "rescued",
              detail: errorSteps.length ? `with step errors: ${errorSteps.join("; ")}` : undefined,
            })
            alertItems.push({
              submission_id: row.id,
              company: companyOf(row),
              tax_year: row.tax_year,
              outcome: "rescued",
              detail: errorSteps.length ? `with step errors: ${errorSteps.join("; ")}` : undefined,
            })
            await reportSystemError({
              source: "server",
              route: ENDPOINT,
              message: "External tax-form completion chain missed its direct fire — rescued by sweep",
              context: { submission_id: row.id, token: row.token, attempt: attempts + 1, errorSteps },
            })
          } else {
            const detail = `http ${res.status}; ${errorSteps.join("; ") || "marker step did not run"}`
            outcomes.push({ submission_id: row.id, token: row.token, outcome: "fire_failed", detail })
            alertItems.push({ submission_id: row.id, company: companyOf(row), tax_year: row.tax_year, outcome: "fire_failed", detail, attempt: attempts + 1 })
            await reportSystemError({
              source: "server",
              route: ENDPOINT,
              http_status: res.status,
              message: "Tax completion sweep fired the chain but the marker step did not succeed",
              context: { submission_id: row.id, token: row.token, attempt: attempts + 1, errorSteps },
            })
          }
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e)
          outcomes.push({ submission_id: row.id, token: row.token, outcome: "fire_failed", detail })
          alertItems.push({ submission_id: row.id, company: companyOf(row), tax_year: row.tax_year, outcome: "fire_failed", detail, attempt: attempts + 1 })
          await reportSystemError({
            source: "server",
            route: ENDPOINT,
            message: "Tax completion sweep POST to the chain route failed",
            context: { submission_id: row.id, token: row.token, attempt: attempts + 1, error: e instanceof Error ? e.message : String(e) },
          })
        }
      }
    }

    // ⚠️ Team-chat alert — a lost submission must be SEEN, not buried in the
    // cron log. One message per run; td-taxreturn first, general as fallback.
    // A failed post never fails the sweep (the log + system-health still have
    // everything), but it is recorded.
    let alertPosted = false
    const alertMessage = formatSweepAlert(alertItems, dryRun)
    if (alertMessage) {
      try {
        await postTeamMessage({ channel: SWEEP_ALERT_CHANNEL, message: alertMessage }).catch(async () => {
          await postTeamMessage({ channel: "general", message: alertMessage })
        })
        alertPosted = true
        for (const { id, meta } of markAlerted) {
          await supabaseAdmin
            .from("tax_return_submissions")
            .update({ financials_meta: { ...meta, [SWEEP_ALERTED_KEY]: true } })
            .eq("id", id)
        }
      } catch (e) {
        outcomes.push({ submission_id: "-", token: null, outcome: "alert_failed", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    const failed = outcomes.some(o => o.outcome === "fire_failed" || o.outcome === "gave_up" || o.outcome === "alert_failed")
    logCron({
      endpoint: ENDPOINT,
      status: failed ? "error" : "success",
      duration_ms: Date.now() - startTime,
      details: { dry_run: dryRun, scanned: rows?.length ?? 0, eligible: eligible.length, outcomes, alert_posted: alertPosted },
    })

    return NextResponse.json({
      ok: true,
      dry_run: dryRun,
      scanned: rows?.length ?? 0,
      eligible: eligible.length,
      outcomes,
      duration_ms: Date.now() - startTime,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: ENDPOINT, status: "error", duration_ms: Date.now() - startTime, details: { error: message } })
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
