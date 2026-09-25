/**
 * Watches the self-hosted WhatsApp bridge (GOWA on the Mac Mini) and emails staff ONCE when it
 * stops working — the bridge emits no disconnect event of its own, so without this a dropped link
 * is silent (dev job 907b2535). Reads the heartbeat the Mac's script records in wa_bridge_state;
 * logic in lib/messaging/wabridge-health.ts.
 *
 * Auth: CRON_SECRET Bearer — FAILS CLOSED when the secret is unset (council review 2026-09-24: `/api/cron`
 * is a public prefix, so an unset secret must not mean "anyone may trigger the alert path").
 * Schedule: vercel.json every 5 minutes, kept in sync with lib/cron-coverage.ts.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { sendDisconnectAlertEmail } from "@/lib/messaging/disconnect-alert"
import { decideBridgeAlert } from "@/lib/messaging/wabridge-health"

const ENDPOINT = "/api/cron/wa-bridge-watch"

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
      .select("id, channel_name, phone_number")
      .eq("provider", "wabridge")
      .eq("is_active", true)
    if (error) throw error

    const ids = (channels ?? []).map((c) => c.id)
    const { data: states, error: stateError } = ids.length
      ? await supabaseAdmin.from("wa_bridge_state").select("*").in("channel_id", ids)
      : { data: [], error: null }
    if (stateError) throw stateError
    const byChannel = new Map((states ?? []).map((s) => [s.channel_id, s]))

    const now = new Date()
    const results: Array<{ channel: string; health: string; alerted: boolean }> = []

    for (const ch of channels ?? []) {
      const decision = decideBridgeAlert(byChannel.get(ch.id), now)
      if (!decision) {
        results.push({ channel: ch.id, health: "unmonitored", alerted: false })
        continue
      }

      // Record the marker BEFORE sending: if the email fails we lose one alert, but a stuck failure can
      // never turn into an email every 5 minutes. Only alerted_state is written (atomic RPC), so a
      // concurrent heartbeat cannot be overwritten and cannot erase this marker.
      if (decision.nextAlertedState !== undefined) {
        const { error: upErr } = await supabaseAdmin.rpc("wabridge_set_alerted", {
          p_channel_id: ch.id,
          p_state: decision.nextAlertedState,
        })
        if (upErr) throw upErr
      }
      if (decision.alert) {
        await sendDisconnectAlertEmail({
          channelName: ch.phone_number ?? ch.channel_name,
          reason: decision.reason,
          hint: decision.hint,
          source: "the WhatsApp bridge watchdog",
        })
      }
      results.push({ channel: ch.id, health: decision.health, alerted: decision.alert })
    }

    const duration_ms = Date.now() - start
    logCron({ endpoint: ENDPOINT, status: "success", duration_ms, details: { checked: results.length, results } })
    return NextResponse.json({ ok: true, duration_ms, checked: results.length, results })
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
