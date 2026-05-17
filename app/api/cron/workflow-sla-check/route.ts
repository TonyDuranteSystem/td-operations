/**
 * CRON: Workflow SLA Check (Slice 10)
 *
 * Runs hourly. For every open workflow task (status NOT IN ('Done','Cancelled')
 * AND workflow_snapshot IS NOT NULL):
 *   - Reads SLA config from the PINNED workflow_snapshot.sla
 *   - Calls decideSlaTier(task, sla, now) — pure logic, time-travel testable
 *   - On 'warn' tier (first time): stamps task_meta.sla_state='warn' +
 *     sla_warned_at. No reassignment, no email — just the yellow badge in
 *     the TaskCard.
 *   - On 'escalate' tier (first time):
 *       (a) stamps task_meta.sla_state='escalated' + escalated_at
 *       (b) if sla.auto_reassign !== false → updates tasks.assigned_to to
 *           sla.escalate_to
 *       (c) if sla.notify_email_to !== "" (default support@) → sends staff
 *           Gmail with task summary
 *   - On *_no_op tiers: no-op (idempotency)
 *
 * Idempotency: task_meta.sla_state acts as the once-per-tier debounce key.
 * Re-running the cron on a 'warn' task that's still in warn returns
 * tier='warn_no_op' from the pure helper → cron skips the write.
 *
 * Dry-run safety: WORKFLOW_SLA_DRY_RUN=true returns the decisions in the
 * response without writing/notifying. Recommended for the first production
 * week after Slice 14 ships.
 *
 * Schedule: every hour (configured in vercel.json).
 * Auth: Bearer CRON_SECRET (same pattern as every other cron in this repo).
 *
 * Slice 10 of the Workflow System build. See dev_task e364e980.
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { decideSlaTier, type SlaConfig, type SlaDecision } from "@/lib/tasks/sla-eligibility"
import { updateTask } from "@/lib/operations/task"

export const maxDuration = 60

const DEFAULT_NOTIFY_EMAIL = "support@tonydurante.us"
const FROM_HEADER = "Tony Durante CRM <support@tonydurante.us>"

interface SkippedCounters {
  no_sla: number
  within_warn: number
  warn_no_op: number
  escalate_no_op: number
  invalid_dates: number
  schema_invalid: number
}

interface ProcessedTask {
  task_id: string
  workflow_slug: string | null
  decision: SlaDecision
  /** Action taken (or would-be in dry-run). */
  action: "warned" | "escalated" | "skipped" | "dry_run_warned" | "dry_run_escalated"
  reassigned_to?: string | null
  emailed_to?: string | null
  error?: string
}

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const isDryRun = process.env.WORKFLOW_SLA_DRY_RUN === "true"
  const now = new Date()
  const results: {
    scanned: number
    warned: number
    escalated: number
    skipped: SkippedCounters
    errors: Array<{ task_id: string; error: string }>
    dry_run: boolean
    processed?: ProcessedTask[]
  } = {
    scanned: 0,
    warned: 0,
    escalated: 0,
    skipped: {
      no_sla: 0,
      within_warn: 0,
      warn_no_op: 0,
      escalate_no_op: 0,
      invalid_dates: 0,
      schema_invalid: 0,
    },
    errors: [],
    dry_run: isDryRun,
    processed: isDryRun ? [] : undefined,
  }

  try {
    // Pull all open workflow tasks. workflow_snapshot is JSONB — we use
    // .not("workflow_snapshot", "is", null) to filter. workflow_slug/snapshot
    // typed loosely until lib/database.types.ts regen.
    const { data: tasks, error: queryErr } = await supabaseAdmin
      .from("tasks")
      .select("id, created_at, task_meta, workflow_slug, workflow_snapshot, assigned_to, account_id")
      .neq("status", "Done")
      .neq("status", "Cancelled")
      .not("workflow_snapshot" as never, "is", null)
      .order("created_at", { ascending: true })

    if (queryErr) {
      throw new Error(`tasks query failed: ${queryErr.message}`)
    }

    results.scanned = tasks?.length ?? 0

    for (const raw of tasks ?? []) {
      const task = raw as unknown as {
        id: string
        created_at: string
        task_meta: Record<string, unknown> | null
        workflow_slug: string | null
        workflow_snapshot: Record<string, unknown> | null
        assigned_to: string | null
        account_id: string | null
      }

      // Extract SLA from snapshot. Loose typed — defensive read.
      const sla = extractSlaFromSnapshot(task.workflow_snapshot)
      if (sla === "invalid_schema") {
        results.skipped.schema_invalid++
        continue
      }

      const decision = decideSlaTier(
        { id: task.id, created_at: task.created_at, task_meta: task.task_meta },
        sla,
        now,
      )

      // ── Counter bumps for tiers that don't trigger action ─────────
      if (decision.tier === "ok") {
        if (decision.reason === "no_sla") results.skipped.no_sla++
        else if (decision.reason === "invalid_dates") results.skipped.invalid_dates++
        else results.skipped.within_warn++
        continue
      }
      if (decision.tier === "warn_no_op") {
        results.skipped.warn_no_op++
        continue
      }
      if (decision.tier === "escalate_no_op") {
        results.skipped.escalate_no_op++
        continue
      }

      // ── Action tiers: warn (first detection) / escalate (first detection)
      if (isDryRun) {
        results.processed?.push({
          task_id: task.id,
          workflow_slug: task.workflow_slug,
          decision,
          action: decision.tier === "warn" ? "dry_run_warned" : "dry_run_escalated",
        })
        if (decision.tier === "warn") results.warned++
        else results.escalated++
        continue
      }

      if (decision.tier === "warn") {
        const r = await applyWarn(task.id)
        if (r.error) {
          results.errors.push({ task_id: task.id, error: r.error })
        } else {
          results.warned++
        }
        continue
      }

      // decision.tier === "escalate"
      const r = await applyEscalate({
        task_id: task.id,
        workflow_slug: task.workflow_slug,
        sla: sla as SlaConfig,
        decision,
        current_assignee: task.assigned_to,
        account_id: task.account_id,
      })
      if (r.error) {
        results.errors.push({ task_id: task.id, error: r.error })
      } else {
        results.escalated++
      }
    }

    const ms = Date.now() - startTime
    logCron({
      endpoint: "workflow-sla-check",
      status: results.errors.length === 0 ? "success" : "error",
      duration_ms: ms,
      details: {
        scanned: results.scanned,
        warned: results.warned,
        escalated: results.escalated,
        skipped: results.skipped,
        error_count: results.errors.length,
        dry_run: isDryRun,
      },
    })

    return NextResponse.json({ ok: true, ...results, elapsed_ms: ms })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const ms = Date.now() - startTime
    logCron({ endpoint: "workflow-sla-check", status: "error", duration_ms: ms, error_message: message })
    return NextResponse.json({ ok: false, error: message, elapsed_ms: ms }, { status: 500 })
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function extractSlaFromSnapshot(
  snapshot: Record<string, unknown> | null,
): SlaConfig | null | "invalid_schema" {
  if (!snapshot || typeof snapshot !== "object") return null
  const slaRaw = (snapshot as Record<string, unknown>).sla
  if (slaRaw === undefined || slaRaw === null) return null
  if (typeof slaRaw !== "object") return "invalid_schema"
  const s = slaRaw as Record<string, unknown>
  const warn = typeof s.warn_hours === "number" ? s.warn_hours : undefined
  const escalate = typeof s.escalate_hours === "number" ? s.escalate_hours : undefined
  const escalate_to = typeof s.escalate_to === "string" ? s.escalate_to : undefined
  if (warn === undefined && escalate === undefined) return null
  return {
    warn_hours: warn,
    escalate_hours: escalate,
    escalate_to,
    auto_reassign: typeof s.auto_reassign === "boolean" ? s.auto_reassign : undefined,
    notify_email_to: typeof s.notify_email_to === "string" ? s.notify_email_to : undefined,
  }
}

async function applyWarn(task_id: string): Promise<{ error?: string }> {
  const nowIso = new Date().toISOString()
  // We need to merge into existing task_meta — fetch first.
  const { data: existing } = await supabaseAdmin
    .from("tasks")
    .select("task_meta" as never)
    .eq("id", task_id)
    .maybeSingle()
  const meta = ((existing as unknown as { task_meta?: Record<string, unknown> | null } | null)?.task_meta) ?? {}
  const next = { ...meta, sla_state: "warn", sla_warned_at: nowIso }
  const r = await updateTask({
    id: task_id,
    // task_meta is typed loosely on tasks until lib/database.types.ts regen
    // (same pattern as createWorkflowTask in lib/operations/task.ts).
    patch: ({ task_meta: next } as unknown) as Parameters<typeof updateTask>[0]["patch"],
    actor: "cron:workflow-sla-check",
    summary: "SLA warn threshold crossed",
    details: { sla_state: "warn", sla_warned_at: nowIso },
  })
  if (!r.success) return { error: `updateTask failed: ${r.error}` }
  return {}
}

interface EscalateArgs {
  task_id: string
  workflow_slug: string | null
  sla: SlaConfig
  decision: Extract<SlaDecision, { tier: "escalate" }>
  current_assignee: string | null
  account_id: string | null
}

async function applyEscalate(args: EscalateArgs): Promise<{ error?: string }> {
  const nowIso = new Date().toISOString()

  const autoReassign = args.sla.auto_reassign !== false // default true
  const escalateTo = args.decision.escalate_to ?? args.sla.escalate_to
  const notifyEmail =
    args.sla.notify_email_to === undefined
      ? DEFAULT_NOTIFY_EMAIL
      : args.sla.notify_email_to.trim() === ""
        ? null // empty string = suppress
        : args.sla.notify_email_to.trim()

  // 1) Merge task_meta + optionally reassign in one updateTask call.
  const { data: existing } = await supabaseAdmin
    .from("tasks")
    .select("task_meta" as never)
    .eq("id", args.task_id)
    .maybeSingle()
  const meta = ((existing as unknown as { task_meta?: Record<string, unknown> | null } | null)?.task_meta) ?? {}
  const nextMeta = {
    ...meta,
    sla_state: "escalated",
    escalated_at: nowIso,
    sla_escalate_to: escalateTo ?? null,
  }
  const patch: Record<string, unknown> = { task_meta: nextMeta }
  if (autoReassign && escalateTo && escalateTo !== args.current_assignee) {
    patch.assigned_to = escalateTo
  }
  const r = await updateTask({
    id: args.task_id,
    patch: (patch as unknown) as Parameters<typeof updateTask>[0]["patch"],
    actor: "cron:workflow-sla-check",
    summary: `SLA escalated${autoReassign && escalateTo ? ` + reassigned to ${escalateTo}` : ""}`,
    details: {
      sla_state: "escalated",
      escalated_at: nowIso,
      hours_waiting: args.decision.hours_waiting,
      escalate_threshold: args.decision.escalate_threshold,
      auto_reassign: autoReassign,
      previous_assignee: args.current_assignee,
    },
  })
  if (!r.success) return { error: `updateTask failed: ${r.error}` }

  // 2) Staff email notification (best-effort — failure is logged but doesn't
  //    fail the escalation since the reassign + state stamp are the primary signal).
  if (notifyEmail) {
    try {
      const { gmailPost } = await import("@/lib/gmail")
      const companyName = await resolveAccountName(args.account_id)
      const subject = `[SLA] Workflow task escalated: ${args.workflow_slug ?? "unknown"}${
        companyName ? ` — ${companyName}` : ""
      }`
      const html = `
        <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">
          <h2 style="color:#b91c1c;margin:0 0 12px 0">SLA escalation triggered</h2>
          <table style="border-collapse:collapse;margin:12px 0">
            <tr><td style="padding:4px 8px;font-weight:bold">Workflow</td><td style="padding:4px 8px">${args.workflow_slug ?? "(unknown)"}</td></tr>
            <tr><td style="padding:4px 8px;font-weight:bold">Task ID</td><td style="padding:4px 8px"><code>${args.task_id}</code></td></tr>
            ${companyName ? `<tr><td style="padding:4px 8px;font-weight:bold">Company</td><td style="padding:4px 8px">${companyName}</td></tr>` : ""}
            <tr><td style="padding:4px 8px;font-weight:bold">Waiting hours</td><td style="padding:4px 8px">${args.decision.hours_waiting.toFixed(1)}h (threshold ${args.decision.escalate_threshold}h)</td></tr>
            <tr><td style="padding:4px 8px;font-weight:bold">Reassigned to</td><td style="padding:4px 8px">${autoReassign && escalateTo ? escalateTo : "(unchanged)"}</td></tr>
            <tr><td style="padding:4px 8px;font-weight:bold">Previous assignee</td><td style="padding:4px 8px">${args.current_assignee ?? "(unassigned)"}</td></tr>
          </table>
          <p style="color:#6b7280;font-size:12px">Sent by cron workflow-sla-check. The task is now flagged in the CRM with a red SLA badge.</p>
        </div>`
      const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
      const rawEmail = [
        `From: ${FROM_HEADER}`,
        `To: ${notifyEmail}`,
        `Subject: ${encodedSubject}`,
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(html).toString("base64"),
      ].join("\r\n")
      await gmailPost("/messages/send", {
        raw: Buffer.from(rawEmail).toString("base64url"),
      })
    } catch (emailErr) {
      console.warn(
        `[workflow-sla-check] escalation email failed for task ${args.task_id}:`,
        emailErr instanceof Error ? emailErr.message : String(emailErr),
      )
      // Continue — escalation succeeded even if email didn't.
    }
  }

  return {}
}

async function resolveAccountName(account_id: string | null): Promise<string | null> {
  if (!account_id) return null
  const { data } = await supabaseAdmin
    .from("accounts")
    .select("company_name")
    .eq("id", account_id)
    .maybeSingle()
  return data?.company_name ?? null
}
