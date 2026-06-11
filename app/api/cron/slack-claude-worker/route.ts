/**
 * Slack Claude Worker cron route
 *
 * Processes agent_messages rows created by the Slack webhook handler
 * (context_json->>'source' = 'slack', recipient = 'claude').
 *
 * Two modes (same handler, GET + POST accepted — mirrors hermes-bridge):
 *
 *   DIRECT mode (POST + ?message_id=<uuid>)
 *     Claim + process exactly that row. Fired from the webhook handler via
 *     fireWorkerTrigger for low latency (~8-15s end-to-end).
 *
 *   SCAN mode (GET, no message_id)
 *     Cron safety net (every 2 min). Recovers stuck 'processing' rows older
 *     than 10 min, then picks up to 5 pending Slack rows the direct trigger
 *     missed.
 *
 * Auth: CRON_SECRET Bearer (same key the webhook handler uses).
 */

export const dynamic = "force-dynamic"
export const maxDuration = 300

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { processSlackEvent, SlackEventRow } from "@/lib/ai-agent/slack-claude"
import { logCron } from "@/lib/cron-log"

const ENDPOINT = "/api/cron/slack-claude-worker"
const STALE_CLAIM_MS = 10 * 60 * 1000
const SCAN_BATCH = 5

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return authHeader === null || authHeader === "Bearer "
  return authHeader === `Bearer ${cronSecret}`
}

async function claimPending(id: string, claimedBy: string): Promise<SlackEventRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("agent_messages")
    .update({
      status: "processing",
      claimed_at: new Date().toISOString(),
      claimed_by: claimedBy,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("id, body, thread_id, context_json")
    .maybeSingle()

  if (error) throw error
  return (data as SlackEventRow | null) ?? null
}

async function recoverStaleClaims(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("agent_messages")
    .update({
      status: "pending",
      claimed_at: null,
      claimed_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq("status", "processing")
    .eq("recipient", "claude")
    .filter("context_json->>source", "eq", "slack")
    .lt("claimed_at", cutoff)
    .select("id")

  if (error) throw error
  return data?.length ?? 0
}

async function processOne(
  row: SlackEventRow,
): Promise<{ id: string; ok: boolean; error?: string }> {
  try {
    await processSlackEvent(row)
    return { id: row.id, ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
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

async function runDirect(messageId: string) {
  const claimed = await claimPending(messageId, "slack-direct-trigger")
  if (!claimed) return { processed: 0, results: [], note: `row ${messageId} not pending` }
  const result = await processOne(claimed)
  return { processed: 1, results: [result] }
}

async function runScan() {
  const recovered = await recoverStaleClaims()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: pending, error } = await (supabaseAdmin as any)
    .from("agent_messages")
    .select("id")
    .eq("recipient", "claude")
    .eq("status", "pending")
    .filter("context_json->>source", "eq", "slack")
    .gt("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: true })
    .limit(SCAN_BATCH)

  if (error) throw error

  const results: Array<{ id: string; ok: boolean; error?: string }> = []
  for (const row of pending ?? []) {
    const claimed = await claimPending(row.id, "slack-cron-worker")
    if (!claimed) continue
    results.push(await processOne(claimed))
  }

  return { recovered, processed: results.length, results }
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const start = Date.now()
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const messageId = req.nextUrl.searchParams.get("message_id")
  const mode = messageId ? "direct" : "scan"

  try {
    const result = mode === "direct"
      ? await runDirect(messageId as string)
      : await runScan()

    const duration_ms = Date.now() - start
    logCron({ endpoint: ENDPOINT, status: "success", duration_ms, details: { mode, ...result } })
    return NextResponse.json({ ok: true, mode, duration_ms, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const duration_ms = Date.now() - start
    logCron({ endpoint: ENDPOINT, status: "error", duration_ms, error_message: message, details: { mode } })
    return NextResponse.json({ ok: false, mode, error: message }, { status: 500 })
  }
}

export async function GET(req: NextRequest) { return handle(req) }
export async function POST(req: NextRequest) { return handle(req) }
