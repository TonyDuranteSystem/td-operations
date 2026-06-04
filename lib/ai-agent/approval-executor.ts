/**
 * Approval executor — Hermes ↔ Claude bridge (Phase 2, Slice 2).
 *
 * This is the RISKY half of the approval rail, deliberately isolated from the
 * queue/read side (Slice 1) so it can be reviewed in one place: it runs REAL
 * actions (create_task, send_email, etc.) once Antonio has approved them.
 *
 * Two entry shapes, both go through runApprovalExecutor():
 *   - DIRECT (id given): claim + execute exactly that one approved row. Fired
 *     awaited-but-3s-bounded by approval_decide(approve) for low latency.
 *   - SCAN (no id): the cron safety net —
 *       (a) re-claim rows stuck in 'executing' > 10 min (crashed mid-run),
 *       (b) execute any 'approved' rows a direct trigger missed,
 *       (c) expire 'pending' rows past expires_at.
 *
 * Safety invariants:
 *   - Kill switch: APPROVAL_RAIL_ENABLED must === 'true' or nothing executes.
 *     (propose_action keeps queuing regardless — the switch only stops running.)
 *   - Atomic claim: UPDATE … WHERE id=X AND status='approved' RETURNING. Exactly
 *     one caller wins; a second claim gets 0 rows and returns early. This is the
 *     ONLY double-execution guard — do not replace with check-then-update.
 *   - params_hash integrity re-check before executing: if the stored params no
 *     longer hash to the stored params_hash, the row is marked 'failed' and the
 *     action is NEVER run (drift / tamper guard).
 *   - executeTool() catches its own errors and returns an {error:...} string
 *     rather than throwing, so we ALSO inspect the result: an error-shaped
 *     result marks the row 'failed', not 'executed'. Marking a failed send as
 *     'executed' would mislead Antonio — so we treat both throws and
 *     error-shaped results as failures.
 *
 * Every terminal transition writes an outcome callback into agent_messages
 * (writeOutcomeCallback) so Hermes can report what happened.
 */

import { executeTool } from "./tools"
import { computeParamsHash } from "./approvable-tools"
import { emitApprovalOutcome, runNotificationSweep } from "./approval-notifications"
import { supabaseAdmin } from "@/lib/supabase-admin"

const STALE_CLAIM_MS = 10 * 60 * 1000 // executing rows older than this are treated as crashed
const SCAN_BATCH = 10                  // max approved rows to execute per cron tick
const CLAIMED_BY = "approval-executor"

export interface ApprovalRow {
  id: string
  tool_name: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>
  params_hash: string
  status: string
}

export type ExecOutcome = "executed" | "failed"

export interface ExecResult {
  id: string
  status: "executed" | "failed" | "skipped"
  reason?: string
}

export interface ExecutorRunResult {
  ok: true
  disabled?: boolean
  mode?: "direct" | "scan"
  recovered?: number
  executed?: number
  expired?: number
  notified?: number
  results?: ExecResult[]
  note?: string
}

/** Kill switch — execution only runs when APPROVAL_RAIL_ENABLED === 'true'. */
export function isApprovalRailEnabled(): boolean {
  return process.env.APPROVAL_RAIL_ENABLED === "true"
}

/**
 * Interpret an executeTool() string return. executeTool never throws (it catches
 * internally and returns an {error:...} JSON string), so a successful-looking
 * string is NOT proof of success — we parse and look for an error shape.
 *   - parses to an object with an `error` key → failure
 *   - parses to an object/array          → that value is the result
 *   - non-JSON string                    → { text: <raw> }
 */
export function interpretToolResult(raw: string): { ok: boolean; result: unknown; error?: string } {
  let parsed: unknown = raw
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* not JSON — keep the raw string */
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in (parsed as Record<string, unknown>)) {
    const e = (parsed as Record<string, unknown>).error
    return { ok: false, result: parsed, error: typeof e === "string" ? e : JSON.stringify(e) }
  }
  const result = parsed !== null && typeof parsed === "object" ? parsed : { text: raw }
  return { ok: true, result }
}

/**
 * Atomically claim an approved row for execution (approved → executing).
 * Returns the row if this caller won the claim, null otherwise (already
 * claimed/executed/rejected/expired).
 */
export async function claimApproval(id: string): Promise<ApprovalRow | null> {
  const nowIso = new Date().toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("approval_queue")
    .update({
      status: "executing",
      claimed_at: nowIso,
      claimed_by: CLAIMED_BY,
      updated_at: nowIso,
    })
    .eq("id", id)
    .eq("status", "approved")
    .select("id, tool_name, params, params_hash, status")
    .maybeSingle()

  if (error) throw error
  return (data as ApprovalRow | null) ?? null
}

/** Finalize an approval row to a terminal execution state. */
async function finalize(
  id: string,
  status: ExecOutcome,
  extra: { result?: unknown; error_text?: string },
): Promise<void> {
  const nowIso = new Date().toISOString()
  const patch: Record<string, unknown> = {
    status,
    executed_at: nowIso,
    updated_at: nowIso,
  }
  if (extra.result !== undefined) patch.result = extra.result
  if (extra.error_text !== undefined) patch.error_text = extra.error_text.slice(0, 10000)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabaseAdmin as any)
    .from("approval_queue")
    .update(patch)
    .eq("id", id)
  if (error) throw error
}

/**
 * Execute an already-claimed (status='executing') row: integrity re-check →
 * executeTool → finalize executed/failed → outcome callback. Never re-runs an
 * already-terminal row because the caller only ever passes freshly-claimed rows.
 */
export async function executeApprovalRow(row: ApprovalRow): Promise<ExecResult> {
  // The proposal row, reused for richer CRM-chat notification formatting.
  const notifyRow = { id: row.id, tool_name: row.tool_name, params: row.params }

  // 1) Integrity: stored params must still hash to the stored params_hash.
  const recomputed = computeParamsHash(row.params)
  if (recomputed !== row.params_hash) {
    await finalize(row.id, "failed", { error_text: "params_hash integrity mismatch" })
    await emitApprovalOutcome({
      id: row.id,
      tool_name: row.tool_name,
      status: "failed",
      summary: `Proposal ${row.tool_name} NOT executed: params_hash integrity mismatch (stored params changed since approval).`,
      row: notifyRow,
    })
    return { id: row.id, status: "failed", reason: "integrity" }
  }

  // 2) Execute the real action.
  let raw: string
  try {
    raw = await executeTool(row.tool_name, row.params)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await finalize(row.id, "failed", { error_text: msg })
    await emitApprovalOutcome({
      id: row.id,
      tool_name: row.tool_name,
      status: "failed",
      summary: `Proposal ${row.tool_name} failed: ${msg}`,
      row: notifyRow,
    })
    return { id: row.id, status: "failed", reason: "throw" }
  }

  // 3) executeTool doesn't throw on logical failure — inspect the result.
  const interp = interpretToolResult(raw)
  if (!interp.ok) {
    await finalize(row.id, "failed", { result: interp.result, error_text: interp.error ?? "tool error" })
    await emitApprovalOutcome({
      id: row.id,
      tool_name: row.tool_name,
      status: "failed",
      summary: `Proposal ${row.tool_name} failed: ${interp.error ?? "tool error"}`,
      row: notifyRow,
    })
    return { id: row.id, status: "failed", reason: "tool_error" }
  }

  // 4) Success.
  await finalize(row.id, "executed", { result: interp.result })
  await emitApprovalOutcome({
    id: row.id,
    tool_name: row.tool_name,
    status: "executed",
    summary: `Proposal ${row.tool_name} executed successfully.`,
    row: notifyRow,
  })
  return { id: row.id, status: "executed" }
}

/** Direct mode: claim + execute exactly one row. */
export async function executeApproval(id: string): Promise<ExecResult> {
  const claimed = await claimApproval(id)
  if (!claimed) {
    return { id, status: "skipped", reason: "not approved (already claimed, decided, or not found)" }
  }
  return executeApprovalRow(claimed)
}

/**
 * Crash recovery: reset rows stuck in 'executing' for > 10 min back to
 * 'approved' so the scan re-executes them. Returns how many were recovered.
 */
export async function recoverStuckExecuting(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  const nowIso = new Date().toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("approval_queue")
    .update({
      status: "approved",
      claimed_at: null,
      claimed_by: null,
      updated_at: nowIso,
    })
    .eq("status", "executing")
    .lt("claimed_at", cutoff)
    .select("id")
  if (error) throw error
  return data?.length ?? 0
}

/**
 * Expire pending proposals past their expires_at. Atomic transition
 * (pending → expired, only where still pending) + an outcome callback per row.
 * Returns how many were expired.
 */
export async function expireStalePending(): Promise<number> {
  const nowIso = new Date().toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("approval_queue")
    .update({ status: "expired", updated_at: nowIso })
    .eq("status", "pending")
    .lt("expires_at", nowIso)
    .select("id, tool_name, params, rationale")
  if (error) throw error

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []) as Array<{ id: string; tool_name: string; params?: Record<string, any> | null; rationale?: string | null }>
  for (const r of rows) {
    // Each expiry writes the Hermes callback, flips notification_sent, and mirrors
    // to the CRM team chat (deliverable #3).
    await emitApprovalOutcome({
      id: r.id,
      tool_name: r.tool_name,
      status: "expired",
      summary: `Proposal ${r.tool_name} expired (not approved before its expiry window).`,
      row: { id: r.id, tool_name: r.tool_name, params: r.params ?? null, rationale: r.rationale ?? null },
    })
  }
  return rows.length
}

/**
 * Scan mode (cron safety net): recover stale claims, execute approved rows a
 * direct trigger missed, then expire stale pending proposals.
 */
export async function runExecutorScan(): Promise<ExecutorRunResult> {
  const recovered = await recoverStuckExecuting()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: approved, error } = await (supabaseAdmin as any)
    .from("approval_queue")
    .select("id")
    .eq("status", "approved")
    .order("created_at", { ascending: true })
    .limit(SCAN_BATCH)
  if (error) throw error

  const results: ExecResult[] = []
  for (const r of (approved ?? []) as Array<{ id: string }>) {
    results.push(await executeApproval(r.id))
  }

  const expired = await expireStalePending()

  // Retry safety net: re-notify any terminal row whose first callback never set
  // notification_sent (deliverable #1). Runs after the work above so freshly
  // terminal rows from this same tick are already flagged and skipped here.
  const notified = await runNotificationSweep()

  return {
    ok: true,
    mode: "scan",
    recovered,
    executed: results.filter((r) => r.status === "executed").length,
    expired,
    notified,
    results,
  }
}

/**
 * Single entry point used by the route. Honors the kill switch, then dispatches
 * direct vs scan. Never throws on a per-row action failure (those become
 * 'failed' rows); only a query/infrastructure error propagates.
 */
export async function runApprovalExecutor(opts: { id?: string | null }): Promise<ExecutorRunResult> {
  if (!isApprovalRailEnabled()) {
    return { ok: true, disabled: true, note: "APPROVAL_RAIL_ENABLED is not 'true' — execution skipped (proposals still queue)." }
  }
  if (opts.id) {
    const result = await executeApproval(opts.id)
    return { ok: true, mode: "direct", executed: result.status === "executed" ? 1 : 0, results: [result] }
  }
  return runExecutorScan()
}
