/**
 * Weekly voice-note self-test (Mondays 14:00 UTC). Sends one short recording to the chosen test chat and records it in
 * wa_bridge_state.voice_check; staff then answer "did it play?" in the WhatsApp page (rules in lib/messaging/wabridge-voice-check.ts).
 * Does NOTHING until wa_bridge_state.voice_check_group_id names the test chat. Auth: CRON_SECRET Bearer, fails closed.
 */
export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { classifyBridge } from "@/lib/messaging/wabridge-health"
import { decideVoiceCheckSend, parseVoiceCheck } from "@/lib/messaging/wabridge-voice-check"
import { saveVoiceCheck, sendVoiceCheck } from "@/lib/messaging/wabridge-voice-check-send"

const ENDPOINT = "/api/cron/wa-voice-check"

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return false
  return req.headers.get("authorization") === `Bearer ${cronSecret}`
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const start = Date.now()
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const { data: channels, error } = await supabaseAdmin
      .from("messaging_channels").select("id").eq("provider", "wabridge").eq("is_active", true)
    if (error) throw error
    const ids = (channels ?? []).map((c) => c.id)
    const { data: states, error: stateError } = ids.length ? await supabaseAdmin.from("wa_bridge_state").select("*").in("channel_id", ids) : { data: [], error: null }
    if (stateError) throw stateError

    const now = new Date()
    const results: Array<{ channel: string; sent: boolean; reason: string }> = []
    for (const id of ids) {
      const state = (states ?? []).find((s) => s.channel_id === id)
      const row = (state ?? null) as unknown as Record<string, unknown> | null
      const decision = decideVoiceCheckSend({
        testChatId: typeof row?.voice_check_group_id === "string" ? row.voice_check_group_id : null,
        health: classifyBridge(state ?? null, now),
        sendMode: typeof row?.send_mode === "string" ? row.send_mode : null,
        current: parseVoiceCheck(row?.voice_check),
        now,
      })
      if (!decision.send) { results.push({ channel: id, sent: false, reason: decision.reason }); continue }
      const vc = await sendVoiceCheck(id, row?.voice_check_group_id as string, now)
      await saveVoiceCheck(id, vc)
      results.push({ channel: id, sent: vc.status === "sent", reason: vc.status })
    }
    const duration_ms = Date.now() - start
    logCron({ endpoint: ENDPOINT, status: "success", duration_ms, details: { results } })
    return NextResponse.json({ ok: true, duration_ms, results })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logCron({ endpoint: ENDPOINT, status: "error", duration_ms: Date.now() - start, error_message: message })
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function GET(req: NextRequest) { return handle(req) }
export async function POST(req: NextRequest) { return handle(req) }
