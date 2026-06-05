/**
 * Hermes ↔ Claude bridge worker (Phase 1 — research/discussion rail)
 *
 * dev_task: 1a0d1354
 *
 * One endpoint, two modes:
 *
 *  - DIRECT mode (POST + ?message_id=<uuid>)
 *      Process exactly that row immediately. Called from the
 *      agent_msg_send MCP tool via fire-and-forget fetch — low latency
 *      so Hermes feels responsive on Telegram.
 *
 *  - SCAN mode (GET, no message_id)
 *      Cron schedule (vercel.json `*​/5 * * * *`). Picks up any pending rows
 *      the direct trigger missed, AND recovers stuck `processing` rows whose
 *      claim is older than 10 min (worker died after claim).
 *
 * Both modes share the same per-row processing logic, with an atomic claim:
 *   UPDATE agent_messages
 *      SET status='processing', claimed_at=now(), claimed_by=$2
 *    WHERE id=$1 AND status='pending'
 *   RETURNING *
 * If 0 rows return, someone else already claimed — exit quietly for that row.
 *
 * Auth: CRON_SECRET Bearer token. Same key the cron scheduler uses and the
 * agent_msg_send MCP tool uses when firing the direct trigger.
 *
 * Phase 1 scope: research only. Worker has read-only tools (lib/ai-agent/
 * worker-tools.ts). Mutations / sends / code changes belong to the Phase 2
 * approval rail (approval_queue + portal), not this worker.
 */

export const dynamic = "force-dynamic"
// Sonnet tool loops can take 60-120s in practice; 300s ceiling covers the
// whole worker invocation including stale-claim recovery on multiple rows.
export const maxDuration = 300

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { callWorker } from "@/lib/ai-agent/worker-tools"
import { logCron } from "@/lib/cron-log"

const ENDPOINT = "/api/cron/hermes-bridge"
const STALE_CLAIM_MS = 10 * 60 * 1000 // 10 min — anything older is treated as a crashed worker
const SCAN_BATCH = 5                  // process up to N rows per cron tick

type Mode = "direct" | "scan"

interface AgentMessageRow {
  id: string
  sender: string
  recipient: string
  subject: string
  body: string
  status: string
  reply: string | null
  claimed_at: string | null
  claimed_by: string | null
  thread_id: string | null
  context_json: Record<string, unknown> | null
  created_at: string
}

/**
 * Per-request max tool-use override pulled from a message's context_json.
 * Accepts a positive integer in [1, 50]; anything else → undefined so the worker
 * falls back to AGENT_MAX_TOOL_LOOPS (env), then 8. The upper bound is a guard:
 * each loop has a 55s Anthropic timeout under the route's 300s maxDuration, so an
 * absurd value can't make a single invocation run unbounded.
 */
function readMaxIterations(contextJson: Record<string, unknown> | null | undefined): number | undefined {
  const raw = contextJson?.max_iterations
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < 1 || n > 50) return undefined
  return n
}

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  // If CRON_SECRET is unset (local dev without secrets), we allow only the
  // empty-secret case to avoid accidental writes; production always has it.
  if (!cronSecret) return authHeader === null || authHeader === "Bearer "
  return authHeader === `Bearer ${cronSecret}`
}

/**
 * Atomically claim a pending row. Returns the row if successful, null if it
 * was already claimed by someone else (race).
 */
async function claimPending(id: string, claimedBy: string): Promise<AgentMessageRow | null> {
  const { data, error } = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
(supabaseAdmin as any).from("agent_messages")
    .update({
      status: "processing",
      claimed_at: new Date().toISOString(),
      claimed_by: claimedBy,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id, sender, recipient, subject, body, status, reply, claimed_at, claimed_by, thread_id, context_json, created_at")
    .maybeSingle()

  if (error) throw error
  return (data as AgentMessageRow | null) ?? null
}

/**
 * Recover stuck `processing` rows (claimed > 10 min ago — assume worker died).
 * Flips them back to `pending` so the scan picks them up.
 */
async function recoverStaleClaims(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  const { data, error } = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
(supabaseAdmin as any).from("agent_messages")
    .update({
      status: "pending",
      claimed_at: null,
      claimed_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq("status", "processing")
    .lt("claimed_at", cutoff)
    .select("id")

  if (error) throw error
  return data?.length ?? 0
}

/**
 * Run sonnet against a single message and persist the reply.
 */
async function processOne(row: AgentMessageRow): Promise<{ id: string; ok: boolean; error?: string }> {
  try {
    const { reply, toolsUsed } = await callWorker(row.body, {
      threadId: row.thread_id,
      messageId: row.id,
      maxIterations: readMaxIterations(row.context_json),
    })

    const replyText = [
      reply,
      "",
      `_(worker used ${toolsUsed.length} tool call${toolsUsed.length === 1 ? "" : "s"}: ${toolsUsed.join(", ") || "none"})_`,
    ].join("\n")

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any)
      .from("agent_messages")
      .update({
        status: "done",
        reply: replyText,
        replied_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)

    if (error) throw error
    return { id: row.id, ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Mark failed so it stops blocking the queue. Don't throw — caller wants
    // a summary not a 500.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any)
      .from("agent_messages")
      .update({
        status: "failed",
        error_text: msg.slice(0, 10000),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .then(() => undefined, () => undefined)
    return { id: row.id, ok: false, error: msg }
  }
}

/**
 * Direct-mode handler: claim + process the single requested row.
 */
async function runDirect(messageId: string): Promise<{ processed: number; results: Array<{ id: string; ok: boolean; error?: string }>; note?: string }> {
  const claimed = await claimPending(messageId, "direct-trigger")
  if (!claimed) {
    return { processed: 0, results: [], note: `row ${messageId} not pending (already claimed or not found)` }
  }
  const result = await processOne(claimed)
  return { processed: 1, results: [result] }
}

/**
 * Scan-mode handler: stale recovery + claim oldest N pending Hermes→Claude rows.
 */
async function runScan(): Promise<{ recovered: number; processed: number; results: Array<{ id: string; ok: boolean; error?: string }> }> {
  const recovered = await recoverStaleClaims()

  const { data: pending, error } = await // eslint-disable-next-line @typescript-eslint/no-explicit-any
(supabaseAdmin as any).from("agent_messages")
    .select("id")
    .eq("recipient", "claude")
    .eq("status", "pending")
    .gt("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: true })
    .limit(SCAN_BATCH)

  if (error) throw error

  const results: Array<{ id: string; ok: boolean; error?: string }> = []
  for (const row of pending ?? []) {
    const claimed = await claimPending(row.id, "cron-worker")
    if (!claimed) continue // race lost
    const result = await processOne(claimed)
    results.push(result)
  }

  return { recovered, processed: results.length, results }
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const start = Date.now()
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const messageId = req.nextUrl.searchParams.get("message_id")
  const mode: Mode = messageId ? "direct" : "scan"

  try {
    const result = mode === "direct"
      ? await runDirect(messageId as string)
      : await runScan()

    const duration_ms = Date.now() - start
    logCron({
      endpoint: ENDPOINT,
      status: "success",
      duration_ms,
      details: { mode, ...result },
    })
    return NextResponse.json({ ok: true, mode, duration_ms, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const duration_ms = Date.now() - start
    logCron({
      endpoint: ENDPOINT,
      status: "error",
      duration_ms,
      error_message: message,
      details: { mode, message_id: messageId },
    })
    return NextResponse.json({ ok: false, mode, error: message }, { status: 500 })
  }
}

export async function GET(req: NextRequest)  { return handle(req) }
export async function POST(req: NextRequest) { return handle(req) }
