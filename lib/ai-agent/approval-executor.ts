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

// NOTE: runToolByName (the tool dispatcher) is imported DYNAMICALLY at the two call
// sites below, not here — a static import would create a cycle
// (approval-executor → mcp-bridge → agent-approvals → approval-executor). It routes
// the existing 14 approvable AGENT tools through executeTool (unchanged) and
// bridge-proposed tools through the MCP bridge.
import { NO_APPROVAL_SEND_TOOLS } from "./tool-risk"
import { computeParamsHash } from "./approvable-tools"
import { emitApprovalOutcome, runNotificationSweep } from "./approval-notifications"
import { currentApprovalEnv } from "./approval-env"
import { isInstanceStale, type HermesInstanceRow } from "./hermes-health"
import { supabaseAdmin } from "@/lib/supabase-admin"

const STALE_CLAIM_MS = 10 * 60 * 1000 // executing rows older than this are treated as crashed
const SCAN_BATCH = 10                  // max approved rows to execute per cron tick
const CLAIMED_BY = "approval-executor"

/**
 * The primary Operating-Agent instance the server defers to (WP3). When this
 * instance is alive (recent heartbeat), the server executor stays out of the way
 * and lets the Mac Mini claim+execute approved rows. Must match the instance_id
 * the Mac Mini runner heartbeats with (hermes_heartbeat('hermes-mac-mini')).
 */
const PRIMARY_INSTANCE_ID = "hermes-mac-mini"

/**
 * Backup grace (WP3): the server will not back up a freshly-approved row until it
 * has been approved for at least this long — long enough for a briefly-asleep Mac
 * Mini to wake and claim it. Tuned per Antonio's decision (3 min).
 */
export const BACKUP_GRACE_MS = 3 * 60 * 1000

/**
 * Long-strand failsafe (WP3): regardless of whether the Mac Mini looks online,
 * an approved row older than this is backed up by the server so a never-claiming
 * primary can't strand an approval forever. Tuned per Antonio's decision (30 min).
 */
export const LONG_STRAND_MS = 30 * 60 * 1000

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
  /** WP3: approved rows the scan left for the Mac Mini (primary) to claim. */
  deferred?: number
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
 * WP3 — server-is-backup decision (pure, testable). The Mac Mini is the PRIMARY
 * executor: it heartbeats + claims approved rows. The server only steps in when
 * the primary can't, so it never races the Mac Mini on a healthy row.
 *
 * The server backs up an approved row IFF:
 *   - it has been approved longer than BACKUP_GRACE_MS (don't snipe a row a
 *     briefly-asleep Mac Mini is about to claim on wake), AND
 *   - the primary instance is stale/offline (no recent heartbeat) OR the row has
 *     stranded past LONG_STRAND_MS (failsafe so a never-online primary can't
 *     pin an approval forever).
 *
 * Reference time = decided_at (set at approve) ?? created_at. If neither parses,
 * the row's age is treated as infinite → eligible for backstop, so a malformed
 * row can never strand silently.
 */
export function serverShouldBackstop(
  row: { decided_at?: string | null; created_at?: string | null },
  instanceRow: HermesInstanceRow | null,
  nowMs: number,
): boolean {
  const ref = row.decided_at ?? row.created_at ?? null
  const refMs = ref ? new Date(ref).getTime() : NaN
  const age = Number.isNaN(refMs) ? Number.POSITIVE_INFINITY : nowMs - refMs
  if (age <= BACKUP_GRACE_MS) return false
  const stale = isInstanceStale(instanceRow?.last_heartbeat ?? null, nowMs)
  return stale || age > LONG_STRAND_MS
}

/** Load the primary Operating-Agent instance row (null if it has never beat). */
async function loadPrimaryInstance(): Promise<HermesInstanceRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("hermes_instances")
    .select("instance_id, last_heartbeat, status")
    .eq("instance_id", PRIMARY_INSTANCE_ID)
    .maybeSingle()
  if (error) throw error
  return (data as HermesInstanceRow | null) ?? null
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
    // Lane guard (Phase D): only execute rows in THIS executor's env. By default
    // every row + executor are 'production', so this is inert until APPROVAL_ENV
    // carves a staging lane. A mismatched-env row yields 0 rows → skipped.
    .eq("env", currentApprovalEnv())
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

  // PIN-DEPENDENT SEND GUARD (dev job a6c3d75b, council Security + SE finding):
  // this path dispatches straight to the tool with the params frozen at propose
  // time, so it NEVER re-enters the worker's send executor where the recipient pin
  // lives. An approved send would therefore run with the recipient the MODEL chose,
  // silently skipping the strongest control on a surface that reads mail written by
  // strangers. Refuse — the worker already sends through its pinned path on the
  // staff member's explicit "go".
  if (NO_APPROVAL_SEND_TOOLS.has(row.tool_name)) {
    const why =
      `"${row.tool_name}" cannot be executed from an approval — its recipient safety check only exists on the ` +
      `worker's own send path. Send it from the chat instead (the worker will show the draft and send on your "go").`
    await finalize(row.id, "failed", { error_text: why })
    await emitApprovalOutcome({
      id: row.id,
      tool_name: row.tool_name,
      status: "failed",
      summary: `Proposal ${row.tool_name} NOT executed: blocked send (recipient pin cannot be verified from an approval).`,
      row,
    })
    return { id: row.id, status: "failed", reason: "blocked_send" }
  }

  // 2) Execute the real action.
  let raw: string
  try {
    const { runToolByName } = await import("./mcp-bridge")
    raw = await runToolByName(row.tool_name, row.params)
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

/**
 * Guarded finalize for the Mac Mini path (WP3). Unlike finalize(), this only
 * flips a row STILL in 'executing' (WHERE status='executing') and stamps
 * executed_by from the claiming instance, so a concurrent approval_complete or
 * cron crash-recovery can't double-finalize. Returns true iff this caller won
 * the finalize (so the caller knows whether to emit the outcome notification).
 */
async function finalizeClaimed(
  id: string,
  status: ExecOutcome,
  executedBy: string | null,
  extra: { result?: unknown; error_text?: string },
): Promise<boolean> {
  const nowIso = new Date().toISOString()
  const patch: Record<string, unknown> = {
    status,
    executed_at: nowIso,
    executed_by: executedBy ?? null,
    notification_sent: false,
    updated_at: nowIso,
  }
  if (extra.result !== undefined) patch.result = extra.result
  if (extra.error_text !== undefined) patch.error_text = extra.error_text.slice(0, 10000)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("approval_queue")
    .update(patch)
    .eq("id", id)
    .eq("status", "executing")
    .select("id")
    .maybeSingle()
  if (error) throw error
  return !!data
}

/**
 * WP3 — execute a row the Operating Agent (Mac Mini) already claimed via
 * approval_claim (so it is status='executing', claimed_by=<instance>). This is
 * the server tool approval_execute(id)'s engine: the Mac Mini decides WHEN to run
 * (claim), the server does the RUNNING on the same tested path the server
 * executor uses — no per-tool translation on the Mac Mini side.
 *
 * Reuses the proven building blocks (computeParamsHash → executeTool →
 * interpretToolResult → emitApprovalOutcome). Differs from executeApprovalRow by
 * (a) requiring the row already be 'executing' (it does NOT claim), (b) stamping
 * executed_by from claimed_by, and (c) a GUARDED finalize so it can't
 * double-finalize against a concurrent approval_complete / cron recovery.
 */
export async function executeClaimedRow(id: string): Promise<ExecResult> {
  // 1) Read the claimed row; require it to be 'executing'.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error: readErr } = await (supabaseAdmin as any)
    .from("approval_queue")
    .select("id, tool_name, params, params_hash, status, claimed_by, rationale")
    .eq("id", id)
    .maybeSingle()
  if (readErr) throw readErr
  if (!row) return { id, status: "skipped", reason: "not found" }
  if (row.status !== "executing") {
    return { id, status: "skipped", reason: `not executing (status='${row.status}') — claim it first via approval_claim` }
  }

  const claimedBy: string | null = row.claimed_by ?? null
  const notifyRow = { id: row.id, tool_name: row.tool_name, params: row.params ?? {}, rationale: row.rationale ?? null }

  // 2) Integrity re-check (second line; approval_claim already checked once).
  const recomputed = computeParamsHash(row.params ?? {})
  if (recomputed !== row.params_hash) {
    const won = await finalizeClaimed(id, "failed", claimedBy, { error_text: "params_hash integrity mismatch" })
    if (won) {
      await emitApprovalOutcome({
        id,
        tool_name: row.tool_name,
        status: "failed",
        summary: `Proposal ${row.tool_name} NOT executed: params_hash integrity mismatch (stored params changed since approval).`,
        row: notifyRow,
      })
    }
    return { id, status: "failed", reason: "integrity" }
  }

  // PIN-DEPENDENT SEND GUARD (dev job a6c3d75b, council Security + SE finding):
  // this path dispatches straight to the tool with the params frozen at propose
  // time, so it NEVER re-enters the worker's send executor where the recipient pin
  // lives. An approved send would therefore run with the recipient the MODEL chose,
  // silently skipping the strongest control on a surface that reads mail written by
  // strangers. Refuse — the worker already sends through its pinned path on the
  // staff member's explicit "go".
  if (NO_APPROVAL_SEND_TOOLS.has(row.tool_name)) {
    const why =
      `"${row.tool_name}" cannot be executed from an approval — its recipient safety check only exists on the ` +
      `worker's own send path. Send it from the chat instead (the worker will show the draft and send on your "go").`
    const won = await finalizeClaimed(id, "failed", claimedBy, { error_text: why })
    if (won) {
      await emitApprovalOutcome({ id, tool_name: row.tool_name, status: "failed", summary: `Proposal ${row.tool_name} NOT executed: blocked send (recipient pin cannot be verified from an approval).`, row: notifyRow })
    }
    return { id, status: "failed", reason: "blocked_send" }
  }

  // 3) Execute the real action (same path as the server executor).
  let raw: string
  try {
    const { runToolByName } = await import("./mcp-bridge")
    raw = await runToolByName(row.tool_name, row.params ?? {})
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const won = await finalizeClaimed(id, "failed", claimedBy, { error_text: msg })
    if (won) {
      await emitApprovalOutcome({ id, tool_name: row.tool_name, status: "failed", summary: `Proposal ${row.tool_name} failed: ${msg}`, row: notifyRow })
    }
    return { id, status: "failed", reason: "throw" }
  }

  // 4) executeTool doesn't throw on logical failure — inspect the result.
  const interp = interpretToolResult(raw)
  if (!interp.ok) {
    const won = await finalizeClaimed(id, "failed", claimedBy, { result: interp.result, error_text: interp.error ?? "tool error" })
    if (won) {
      await emitApprovalOutcome({ id, tool_name: row.tool_name, status: "failed", summary: `Proposal ${row.tool_name} failed: ${interp.error ?? "tool error"}`, row: notifyRow })
    }
    return { id, status: "failed", reason: "tool_error" }
  }

  // 5) Success.
  const won = await finalizeClaimed(id, "executed", claimedBy, { result: interp.result })
  if (won) {
    await emitApprovalOutcome({ id, tool_name: row.tool_name, status: "executed", summary: `Proposal ${row.tool_name} executed successfully.`, row: notifyRow })
  }
  return { id, status: won ? "executed" : "skipped", reason: won ? undefined : "already finalized by another caller" }
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
    .eq("env", currentApprovalEnv())
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
    .eq("env", currentApprovalEnv())
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
 * Scan mode (cron safety net, WP3 = BACKUP only): recover stale claims, then
 * back up ONLY the approved rows the Mac Mini (primary) failed to claim —
 * serverShouldBackstop gates each row on the grace window + primary liveness —
 * then expire stale pending proposals.
 *
 * This replaced the old "execute every approved row" behaviour: approve no
 * longer instant-fires the server (the fireExecutorTrigger call was removed from
 * approval_decide), and this scan defers to the Mac Mini unless it's stale or a
 * row has stranded. The atomic claim still guarantees no double-execution if the
 * Mac Mini and the server ever target the same row in the same window.
 */
export async function runExecutorScan(): Promise<ExecutorRunResult> {
  const recovered = await recoverStuckExecuting()
  const nowMs = Date.now()

  // Primary liveness drives the backstop decision (loaded once per scan).
  const instanceRow = await loadPrimaryInstance()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: approved, error } = await (supabaseAdmin as any)
    .from("approval_queue")
    .select("id, decided_at, created_at")
    .eq("status", "approved")
    .eq("env", currentApprovalEnv())
    .order("created_at", { ascending: true })
    .limit(SCAN_BATCH)
  if (error) throw error

  const results: ExecResult[] = []
  let deferred = 0
  for (const r of (approved ?? []) as Array<{ id: string; decided_at?: string | null; created_at?: string | null }>) {
    if (!serverShouldBackstop(r, instanceRow, nowMs)) {
      // Mac Mini is primary + healthy (or the grace window hasn't elapsed) —
      // leave this row for it to claim.
      deferred++
      continue
    }
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
    deferred,
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
