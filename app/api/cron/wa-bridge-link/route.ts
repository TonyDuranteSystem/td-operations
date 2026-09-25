/**
 * Links WhatsApp chats to their lead / contact by PHONE NUMBER — every minute (dev job 907b2535).
 *
 * Antonio 2026-09-24: the CRM must recognise a number as a known person ("not Unknown"), and when he saves the number on a
 * lead/contact the chat must pick it up promptly. Rather than a trigger on the core lead/contact tables, this sweep asks the
 * database (wabridge_link_unlinked → wabridge_link_chat) to link every active, still-unlinked chat of each bridge channel.
 * The rules live in SQL (migration 20260925-0100): full-number match only, exactly ONE person, never overwrite an existing
 * link, and the phone-saved name must be fully contained in the CRM name (or the other way round) — otherwise the chat is left
 * for a human; a chat with no comparable name is linked on the number alone only after the phone's names have been synced.
 *
 * Auth: CRON_SECRET Bearer, FAILING CLOSED when unset (same as wa-bridge-watch). Schedule: vercel.json every minute,
 * kept in sync with lib/cron-coverage.ts.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"

const ENDPOINT = "/api/cron/wa-bridge-link"

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false
  return req.headers.get("authorization") === `Bearer ${cronSecret}`
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const start = Date.now()
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { data: channels, error } = await supabaseAdmin
      .from("messaging_channels")
      .select("id")
      .eq("provider", "wabridge")
      .eq("is_active", true)
    if (error) throw error

    // Per-outcome counts so chats the rules HELD BACK are visible in the cron log, not silently dropped:
    // linked | mismatch (names disagree) | ambiguous (two people share the number) | waiting (name not synced yet) | none
    const totals: Record<string, number> = {}
    for (const ch of channels ?? []) {
      const { data, error: rpcError } = await supabaseAdmin.rpc("wabridge_link_unlinked", { p_channel_id: ch.id })
      if (rpcError) throw rpcError
      for (const [outcome, n] of Object.entries((data ?? {}) as Record<string, number>)) {
        totals[outcome] = (totals[outcome] ?? 0) + Number(n)
      }
    }
    const linked = totals.linked ?? 0

    const duration_ms = Date.now() - start
    logCron({ endpoint: ENDPOINT, status: "success", duration_ms, details: { channels: (channels ?? []).length, linked, outcomes: totals } })
    return NextResponse.json({ ok: true, duration_ms, channels: (channels ?? []).length, linked, outcomes: totals })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logCron({ endpoint: ENDPOINT, status: "error", duration_ms: Date.now() - start, error_message: message })
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return handle(req)
}
export async function POST(req: NextRequest) {
  return handle(req)
}
