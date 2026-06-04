/**
 * Approval notifications — Hermes ↔ Claude bridge (Phase 2, Phase B: safety + visibility).
 *
 * Phase 2 (Slice 2) already writes a one-shot agent_messages callback to Hermes
 * at each terminal transition. Phase B hardens that into a reliable, visible
 * notification layer with three pieces, all living here:
 *
 *   1. sendApprovalNotification(row, kind, detail?) — mirror a proposal / outcome
 *      into the CRM "Team" tab (internal_threads / internal_messages) so staff
 *      see it even before Hermes surfaces it on Telegram. Best-effort: NEVER
 *      throws — a CRM/push failure must never block execution or the Hermes
 *      callback. The executor is plain lib code and cannot call the portal_team_send
 *      MCP tool, so we write the same two tables directly (same shape that tool uses).
 *
 *   2. emitApprovalOutcome({id, tool_name, status, summary, row?}) — the single
 *      terminal-notification path used by every terminal transition (executor
 *      success/failure/integrity/expiry + the approval_decide reject path). It:
 *        a) writes the durable Hermes callback (writeOutcomeCallback → agent_messages),
 *        b) on success, flips approval_queue.notification_sent = TRUE,
 *        c) mirrors the outcome to the CRM team chat (best-effort).
 *      notification_sent tracks the *Hermes channel* specifically (step a+b); the
 *      CRM mirror is a bonus and never gates the flag.
 *
 *   3. runNotificationSweep() — the retry safety net (deliverable #1). Any
 *      terminal row still notification_sent=FALSE (its first callback failed, or
 *      a crash landed between the agent_messages write and the flag flip) is
 *      re-emitted. Run at the tail of the executor's scan-mode cron tick.
 *
 * SYSTEM CHANNEL: outcomes/proposals have no single client context, so they go to
 * a dedicated null-account/null-contact team thread (titled below). This mirrors
 * the existing "__team_general__" pattern (app/api/team-chat/route.ts) — a titled
 * client-less thread renders cleanly in the Team tab (company_name falls back to
 * the thread title). internal_threads.created_by / internal_messages.sender_id are
 * NOT NULL but have NO FK, so the all-zeros system sender is valid.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { writeOutcomeCallback, type OutcomeStatus } from "./approval-callback"
import {
  formatApprovalOutcome,
  formatProposeNotification,
  type ApprovalProposalRow,
  type ApprovalOutcomeStatus,
} from "./format-approval-proposal"

/** Dedicated system team thread for approval-rail notifications (null account/contact). */
const APPROVAL_RAIL_THREAD_TITLE = "🤖 Approval Rail (system)"
/** All-zeros system actor — matches the SYSTEM_SENDER_ID convention used elsewhere. */
const SYSTEM_SENDER_ID = "00000000-0000-0000-0000-000000000000"
const SYSTEM_SENDER_NAME = "Approval Rail"

/** What kind of notification to render. "proposed" + the four terminal outcomes. */
export type NotificationKind = "proposed" | ApprovalOutcomeStatus

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any

/**
 * Find (or create) the dedicated approval-rail system team thread and return its
 * id, or null on failure. Mirrors the find-or-create pattern in
 * app/api/team-chat/route.ts, but matched on title only (no .is() null filters)
 * for query-builder portability. The title is a unique sentinel, so eq-on-title
 * is sufficient.
 */
async function getSystemThreadId(): Promise<string | null> {
  const db = supabaseAdmin as AnyDb
  const { data: found } = await db
    .from("internal_threads")
    .select("id")
    .eq("title", APPROVAL_RAIL_THREAD_TITLE)
    .order("created_at", { ascending: true })
    .limit(1)
  const existing = Array.isArray(found) ? found[0] : found
  if (existing?.id) return existing.id

  const { data: created, error } = await db
    .from("internal_threads")
    .insert({ title: APPROVAL_RAIL_THREAD_TITLE, created_by: SYSTEM_SENDER_ID })
    .select("id")
    .single()
  // A concurrent tick may have created it first — fall back to a re-read.
  if (error || !created?.id) {
    const { data: retry } = await db
      .from("internal_threads")
      .select("id")
      .eq("title", APPROVAL_RAIL_THREAD_TITLE)
      .order("created_at", { ascending: true })
      .limit(1)
    const row = Array.isArray(retry) ? retry[0] : retry
    return row?.id ?? null
  }
  return created.id
}

/** Best-effort push to admins — failure is non-critical and swallowed. */
async function pushToAdmins(title: string, body: string, tag: string): Promise<void> {
  try {
    const db = supabaseAdmin as AnyDb
    const { data: subs } = await db.from("admin_push_subscriptions").select("id").limit(1)
    if (!subs?.length) return
    const { sendPushToAdmin } = await import("@/lib/portal/web-push")
    await sendPushToAdmin({ title, body, url: "/portal-chats?view=internal", tag })
  } catch {
    /* push is non-critical */
  }
}

/**
 * Mirror a proposal / outcome into the CRM team chat. BEST-EFFORT — never throws,
 * returns true only if the message row was written. A failure here must never
 * block execution or the Hermes callback (see emitApprovalOutcome).
 *
 * @param row     proposal row (id + tool_name + optional params/rationale)
 * @param kind    "proposed" or a terminal outcome status
 * @param detail  optional outcome detail (result summary / error / reject reason)
 */
export async function sendApprovalNotification(
  row: ApprovalProposalRow,
  kind: NotificationKind,
  detail?: string | null,
): Promise<boolean> {
  try {
    const text =
      kind === "proposed"
        ? formatProposeNotification(row)
        : formatApprovalOutcome(row, kind, detail)

    const threadId = await getSystemThreadId()
    if (!threadId) return false

    const db = supabaseAdmin as AnyDb
    const { error } = await db.from("internal_messages").insert({
      thread_id: threadId,
      sender_id: SYSTEM_SENDER_ID,
      sender_name: SYSTEM_SENDER_NAME,
      message: text,
    })
    if (error) return false

    const banner =
      kind === "proposed"
        ? `New action proposed: ${row.tool_name}`
        : `Action ${kind}: ${row.tool_name}`
    await pushToAdmins(banner, text.slice(0, 120), `approval-${row.id}`)
    return true
  } catch {
    // Fully self-contained: any failure (including a missing table in a test
    // harness) is swallowed so the caller's core path is never affected.
    return false
  }
}

/** Flip approval_queue.notification_sent = TRUE for a row. Returns success. */
async function markNotificationSent(approvalId: string): Promise<boolean> {
  try {
    const db = supabaseAdmin as AnyDb
    const { error } = await db
      .from("approval_queue")
      .update({ notification_sent: true, updated_at: new Date().toISOString() })
      .eq("id", approvalId)
    return !error
  } catch {
    return false
  }
}

/**
 * The single terminal-notification path. Writes the durable Hermes callback,
 * flips notification_sent on success, then mirrors to the CRM team chat.
 *
 * Returns true if Hermes was notified (callback written AND flag flipped) — i.e.
 * this row will NOT be picked up by the retry sweep. The CRM mirror is best-effort
 * and does not affect the return value or the flag (notification_sent tracks the
 * Hermes channel specifically).
 */
export async function emitApprovalOutcome(args: {
  id: string
  tool_name: string
  status: OutcomeStatus
  summary: string
  /** Full row for richer CRM-chat formatting (params/rationale). Optional. */
  row?: ApprovalProposalRow | null
  /** Optional detail line for the CRM card (defaults to `summary`). */
  detail?: string | null
}): Promise<boolean> {
  // a) Durable Hermes channel.
  const callbackOk = await writeOutcomeCallback(args.id, args.tool_name, args.summary, args.status)

  // b) Flip the flag only if the Hermes callback landed, so the sweep retries
  //    rows whose callback failed.
  let notified = false
  if (callbackOk) {
    notified = await markNotificationSent(args.id)
  }

  // c) CRM team-chat mirror — best-effort, never gates the flag.
  const row: ApprovalProposalRow = args.row ?? { id: args.id, tool_name: args.tool_name }
  await sendApprovalNotification(row, args.status, args.detail ?? args.summary)

  return callbackOk && notified
}

/** Terminal statuses that warrant a Hermes notification. */
const TERMINAL_STATUSES = new Set<OutcomeStatus>(["executed", "failed", "rejected", "expired"])
const SWEEP_BATCH = 50

interface SweepRow {
  id: string
  tool_name: string
  status: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any> | null
  rationale?: string | null
  result?: unknown
  error_text?: string | null
}

/** Human detail line for a swept row, derived from its stored outcome columns. */
function sweepSummary(r: SweepRow): string {
  switch (r.status) {
    case "executed":
      return `Proposal ${r.tool_name} executed successfully.`
    case "failed":
      return `Proposal ${r.tool_name} failed: ${r.error_text ?? "unknown error"}.`
    case "rejected":
      return `Proposal ${r.tool_name} rejected.`
    case "expired":
      return `Proposal ${r.tool_name} expired (not approved before its expiry window).`
    default:
      return `Proposal ${r.tool_name} ${r.status}.`
  }
}

/**
 * Retry safety net (deliverable #1). Re-emit notifications for terminal rows
 * whose first callback never set notification_sent. Returns how many were
 * (re)notified. Never throws on a per-row failure — a row that fails to notify
 * stays notification_sent=FALSE and is retried next tick.
 */
export async function runNotificationSweep(): Promise<number> {
  const db = supabaseAdmin as AnyDb
  // Fetch un-notified rows, then filter terminal statuses in JS (avoids needing
  // a .in() filter the lightweight query builder / test mock may not support).
  const { data, error } = await db
    .from("approval_queue")
    .select("id, tool_name, status, params, rationale, result, error_text")
    .eq("notification_sent", false)
    .order("updated_at", { ascending: true })
    .limit(SWEEP_BATCH)
  if (error) throw error

  const rows = ((data ?? []) as SweepRow[]).filter((r) => TERMINAL_STATUSES.has(r.status as OutcomeStatus))

  let notified = 0
  for (const r of rows) {
    const ok = await emitApprovalOutcome({
      id: r.id,
      tool_name: r.tool_name,
      status: r.status as OutcomeStatus,
      summary: sweepSummary(r),
      row: { id: r.id, tool_name: r.tool_name, params: r.params ?? null, rationale: r.rationale ?? null },
    })
    if (ok) notified++
  }
  return notified
}
