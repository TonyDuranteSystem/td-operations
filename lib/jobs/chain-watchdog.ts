/**
 * AI-chain watchdog (Phase 3R amendment v2 — SELF-HEALING, Antonio's rule:
 * "a system that runs and stops, not that I have to check it ran and resume").
 *
 * Runs inside the 5-minute cron. For every scope with recent AI activity:
 * work remains + no live job → re-enqueue the chain automatically on the
 * backoff ladder (15m → 1h → 3h → 6h → 12h). Ladder spent → STOP and ALERT
 * STAFF proactively (throttled email to support@ + action_log marker). Nobody
 * checks anything; nobody clicks Resume.
 *
 * Loop-safety (review F3/F4/F6):
 *  - decideChainState is the same pure brain the GETs render from;
 *  - candidatesRemaining uses the RUNNER'S exact candidate predicate (never
 *    uncategorizedCount — hint-complete rows must not re-fuel the chain);
 *  - post-insert verify: recount live jobs; >1 → compensating delete of our
 *    own insert (SELECT-then-INSERT guards aren't atomic);
 *  - auto_retry increments ONLY off no-progress terminals (handlers reset it
 *    to 0 on progress);
 *  - kill switch suppresses the watchdog entirely;
 *  - scope list bounded: AI jobs in the last 7 days, hard cap 50.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { aiCategorizationDisabled } from "@/lib/tax/ai-categorizer"
import { decideChainState, AI_CHAIN_JOB_PRIORITY, AI_CHAIN_BACKOFF_MS } from "./chain-state"
import { isAccountYearHandsOff } from "@/lib/tax/restale-sweep"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const AI_JOB_TYPES = ["recategorize_workspace_ai", "recategorize_ai"] as const
const SCOPE_LOOKBACK_MS = 7 * 24 * 3600_000
const SCOPE_CAP = 50
const STAFF_ALERT_EMAIL = "support@tonydurante.us"
/** Runner candidate predicate, PostgREST or() form (NULL-safe manual guard). */
const CANDIDATE_ORS = [
  "ai_lean.is.null,ai_bucket.is.null",
  "notes.is.null,notes.not.like.manual:*",
  "and(amount.lt.0,category.in.(uncategorized,expense,fee,cogs)),and(amount.gt.0,category.in.(uncategorized,income))",
] as const

export interface ScopeKey {
  jobType: (typeof AI_JOB_TYPES)[number]
  workspaceId?: string
  accountId?: string
  taxYear?: number
}

interface JobRow {
  id: string
  job_type: string
  status: string
  completed_at: string | null
  related_entity_id: string | null
  account_id: string | null
  payload: { workspace_id?: string; account_id?: string; tax_year?: number; auto_retry?: number } | null
}

function scopeId(s: ScopeKey): string {
  return s.jobType === "recategorize_workspace_ai" ? `ws:${s.workspaceId}` : `acct:${s.accountId}:${s.taxYear}`
}

async function candidatesRemaining(s: ScopeKey): Promise<number> {
  let q = s.jobType === "recategorize_workspace_ai"
    ? db.from("pnl_workspace_transactions").select("id", { count: "exact", head: true }).eq("workspace_id", s.workspaceId)
    : db.from("bank_transactions").select("id", { count: "exact", head: true }).eq("account_id", s.accountId).eq("tax_year", s.taxYear)
  for (const or of CANDIDATE_ORS) q = q.or(or)
  const { count, error } = await q
  if (error) throw new Error(error.message)
  return count ?? 0
}

/** Chain state for ONE scope — the GETs render from this so UI and watchdog
 *  can never disagree (same pure decideChainState, same candidate predicate). */
export async function chainStateForScope(
  key: ScopeKey,
  now = Date.now(),
): Promise<{ state: "running" | "retry_scheduled" | "exhausted" | "idle"; nextRetryAt: number | null; remaining: number; liveJobs: number }> {
  let jobs = db
    .from("job_queue")
    .select("id, status, completed_at, payload")
    .eq("job_type", key.jobType)
    .gte("created_at", new Date(now - SCOPE_LOOKBACK_MS).toISOString())
  jobs = key.jobType === "recategorize_workspace_ai"
    ? jobs.eq("related_entity_id", key.workspaceId)
    : jobs.eq("account_id", key.accountId).eq("payload->>tax_year", String(key.taxYear))
  const { data } = await jobs
  const rows = (data ?? []) as JobRow[]
  const liveJobs = rows.filter(r => r.status === "pending" || r.status === "processing").length
  const terminals = rows
    .filter(r => (r.status === "completed" || r.status === "failed") && r.completed_at)
    .sort((a, b) => (a.completed_at! < b.completed_at! ? 1 : -1))
  const lastTerminal = terminals[0]
    ? { completed_at: terminals[0].completed_at, auto_retry: terminals[0].payload?.auto_retry ?? 0 }
    : null
  const remaining = await candidatesRemaining(key)
  const s = decideChainState({ liveJobs, candidatesRemaining: remaining, lastTerminal, killSwitchOn: aiCategorizationDisabled(), now })
  return { state: s.state, nextRetryAt: s.state === "retry_scheduled" ? s.nextRetryAt : null, remaining, liveJobs }
}

export interface WatchdogResult {
  scopes: number
  reEnqueued: string[]
  exhaustedAlerts: string[]
  /** recategorize_ai scopes where a retry was due but the submission is
   *  already confirmed (or under staff review) — see the guard below. */
  skippedConfirmed: string[]
  errors: string[]
}

export async function runChainWatchdog(now = Date.now()): Promise<WatchdogResult> {
  const out: WatchdogResult = { scopes: 0, reEnqueued: [], exhaustedAlerts: [], skippedConfirmed: [], errors: [] }
  const killSwitchOn = aiCategorizationDisabled()
  if (killSwitchOn) return out

  const { data: jobRows, error } = await db
    .from("job_queue")
    .select("id, job_type, status, completed_at, related_entity_id, account_id, payload")
    .in("job_type", AI_JOB_TYPES as unknown as string[])
    .gte("created_at", new Date(now - SCOPE_LOOKBACK_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(500)
  if (error) { out.errors.push(error.message); return out }

  // Group by scope, newest-first order preserved.
  const scopes = new Map<string, { key: ScopeKey; rows: JobRow[] }>()
  for (const j of (jobRows ?? []) as JobRow[]) {
    const key: ScopeKey = j.job_type === "recategorize_workspace_ai"
      ? { jobType: "recategorize_workspace_ai", workspaceId: j.related_entity_id ?? j.payload?.workspace_id ?? undefined }
      : { jobType: "recategorize_ai", accountId: j.account_id ?? j.payload?.account_id ?? undefined, taxYear: j.payload?.tax_year }
    if (key.jobType === "recategorize_workspace_ai" ? !key.workspaceId : (!key.accountId || !key.taxYear)) continue
    const id = scopeId(key)
    if (!scopes.has(id)) {
      if (scopes.size >= SCOPE_CAP) continue
      scopes.set(id, { key, rows: [] })
    }
    scopes.get(id)!.rows.push(j)
  }
  out.scopes = scopes.size

  for (const [id, { key, rows }] of Array.from(scopes.entries())) {
    try {
      const liveJobs = rows.filter(r => r.status === "pending" || r.status === "processing").length
      const terminals = rows
        .filter(r => (r.status === "completed" || r.status === "failed") && r.completed_at)
        .sort((a, b) => (a.completed_at! < b.completed_at! ? 1 : -1))
      const lastTerminal = terminals[0]
        ? { completed_at: terminals[0].completed_at, auto_retry: terminals[0].payload?.auto_retry ?? 0, jobId: terminals[0].id }
        : null
      if (liveJobs > 0 || !lastTerminal) continue // running or never ran — nothing to do

      const remaining = await candidatesRemaining(key)
      const state = decideChainState({
        liveJobs, candidatesRemaining: remaining,
        lastTerminal: { completed_at: lastTerminal.completed_at, auto_retry: lastTerminal.auto_retry },
        killSwitchOn, now,
      })

      if (state.state === "retry_scheduled" && now >= state.nextRetryAt) {
        // CONFIRMED SUBMISSIONS ARE NEVER TOUCHED (mirrors tax-restale-sweep's
        // rule, same reason): once the client has attested, or staff is
        // actively reviewing, those numbers are off-limits to a background
        // retry — a correction there is staff reopening it, never a cron.
        // Workspace scopes (recategorize_workspace_ai) have no submission to
        // check; only account+year scopes carry one.
        if (key.jobType === "recategorize_ai") {
          const { data: subs } = await db
            .from("tax_return_submissions")
            .select("confirmation_accepted, review_status")
            .eq("account_id", key.accountId)
            .eq("tax_year", key.taxYear)
          const rows = (subs ?? []) as Array<{ confirmation_accepted: boolean | null; review_status: string | null }>
          const handsOff = isAccountYearHandsOff({
            confirmed: rows.some(s => s.confirmation_accepted === true),
            reviewStatuses: rows.map(s => s.review_status),
          })
          if (handsOff) { out.skippedConfirmed.push(id); continue }
        }
        const payload = key.jobType === "recategorize_workspace_ai"
          ? { workspace_id: key.workspaceId, chunk_index: 0, auto_retry: lastTerminal.auto_retry + 1 }
          : { account_id: key.accountId, tax_year: key.taxYear, chunk_index: 0, auto_retry: lastTerminal.auto_retry + 1 }
        const { data: inserted, error: insErr } = await db.from("job_queue").insert({
          job_type: key.jobType,
          payload,
          priority: AI_CHAIN_JOB_PRIORITY,
          account_id: key.jobType === "recategorize_ai" ? key.accountId : null,
          related_entity_type: key.jobType === "recategorize_workspace_ai" ? "pnl_workspace" : null,
          related_entity_id: key.jobType === "recategorize_workspace_ai" ? key.workspaceId : null,
          created_by: "chain-watchdog",
        }).select("id").single()
        if (insErr) throw new Error(insErr.message)
        // Post-insert verify (F3): guards aren't atomic — if a concurrent
        // runner/staff action also inserted, delete OUR row (theirs wins).
        let verify = db.from("job_queue").select("id").in("status", ["pending", "processing"]).eq("job_type", key.jobType)
        verify = key.jobType === "recategorize_workspace_ai"
          ? verify.eq("related_entity_id", key.workspaceId)
          : verify.eq("account_id", key.accountId).eq("payload->>tax_year", String(key.taxYear))
        const { data: live } = await verify
        if ((live ?? []).length > 1) {
          await db.from("job_queue").delete().eq("id", inserted.id).eq("status", "pending")
        } else {
          out.reEnqueued.push(id)
        }
      } else if (state.state === "exhausted") {
        // Alert ONCE per exhaustion event (throttle key = the terminal job id).
        const { data: existing } = await db
          .from("action_log")
          .select("id")
          .eq("action_type", "ai_chain_exhausted")
          .eq("record_id", lastTerminal.jobId)
          .limit(1)
        if (!existing || existing.length === 0) {
          await db.from("action_log").insert({
            actor: "chain-watchdog",
            action_type: "ai_chain_exhausted",
            table_name: "job_queue",
            record_id: lastTerminal.jobId,
            summary: `AI categorization chain exhausted ${AI_CHAIN_BACKOFF_MS.length} auto-retries — scope ${id}, ${await candidatesRemaining(key)} rows unlabeled`,
            details: { scope: id, remaining, last_terminal_job_id: lastTerminal.jobId },
          })
          try {
            const subject = `⚠️ AI categorization needs attention — ${id} (${remaining} rows unlabeled)`
            const html = `
              <div style="font-family:sans-serif">
                <p><strong>The AI categorization chain for <code>${id}</code> stopped after ${AI_CHAIN_BACKOFF_MS.length} automatic retries over ~24h.</strong></p>
                <p>${remaining} rows remain unlabeled. Likely causes: Anthropic API key/quota problem, or a persistent API outage. The failed jobs are in the Exception Center; a staff re-Generate restarts the chain once the cause is fixed.</p>
                <p style="color:#9ca3af;font-size:12px;">Automated staff alert — AI chain watchdog (one email per exhaustion event).</p>
              </div>`
            const { gmailPost } = await import("@/lib/gmail")
            const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
            const boundary = `boundary_${lastTerminal.jobId.slice(0, 8)}`
            const raw = [
              `From: TD Operations <support@tonydurante.us>`,
              `To: ${STAFF_ALERT_EMAIL}`,
              `Subject: ${encodedSubject}`,
              `MIME-Version: 1.0`,
              `Content-Type: multipart/alternative; boundary="${boundary}"`,
              "",
              `--${boundary}`,
              `Content-Type: text/html; charset=UTF-8`,
              `Content-Transfer-Encoding: base64`,
              "",
              Buffer.from(html).toString("base64"),
              `--${boundary}--`,
            ].join("\r\n")
            await gmailPost("/messages/send", { raw: Buffer.from(raw).toString("base64url") })
          } catch (e) {
            console.error("[chain-watchdog] exhaustion email failed (action_log written):", e)
          }
          out.exhaustedAlerts.push(id)
        }
      }
    } catch (e) {
      out.errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}
