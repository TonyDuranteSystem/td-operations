import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { classifyBridge } from "@/lib/messaging/wabridge-health"
import { applyAnswer, decideVoiceCheckSend, parseVoiceCheck, isoWeekKey } from "@/lib/messaging/wabridge-voice-check"
import { saveVoiceCheck, sendVoiceCheck } from "@/lib/messaging/wabridge-voice-check-send"

export const dynamic = "force-dynamic"

/**
 * Answer the weekly voice-note test (any staff), or send a new one.
 * POST { answer: "played" | "not_played" | "resend" }
 *  - played / not_played: records the answer for the CURRENT unanswered test only (a second click, or an answer to an old test, changes nothing)
 *  - resend: sends a fresh test now (after a fix, or when the weekly one could not go out); same safety rules as the weekly job
 * Rules live in lib/messaging/wabridge-voice-check.ts.
 */
export async function POST(request: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  let body: { answer?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }) }
  const answer = body.answer
  if (answer !== "played" && answer !== "not_played" && answer !== "resend") {
    return NextResponse.json({ error: "answer must be played, not_played or resend" }, { status: 400 })
  }

  const { data: channels } = await supabaseAdmin.from("messaging_channels").select("id").eq("provider", "wabridge").eq("is_active", true).limit(1)
  const channelId = channels?.[0]?.id
  if (!channelId) return NextResponse.json({ error: "No WhatsApp line is set up." }, { status: 404 })
  const { data: state } = await supabaseAdmin.from("wa_bridge_state").select("*").eq("channel_id", channelId).maybeSingle()
  const row = (state ?? null) as unknown as Record<string, unknown> | null
  const now = new Date()
  const current = parseVoiceCheck(row?.voice_check)

  if (answer === "resend") {
    const testChatId = typeof row?.voice_check_group_id === "string" ? row.voice_check_group_id : null
    // a new test may go out when the line is healthy and sending is live — never on a week where a test is still waiting for an answer
    const base = decideVoiceCheckSend({ testChatId, health: classifyBridge(state ?? null, now), sendMode: typeof row?.send_mode === "string" ? row.send_mode : null, current: null, now })
    if (!base.send) return NextResponse.json({ error: base.reason === "off" ? "The weekly voice test is not switched on." : "The WhatsApp line is not ready to send a test right now." }, { status: 409 })
    if (current?.status === "sent" && current.week === isoWeekKey(now)) return NextResponse.json({ error: "A test was just sent — answer it first." }, { status: 409 })
    const vc = await sendVoiceCheck(channelId, testChatId as string, now)
    if (!(await saveVoiceCheck(channelId, vc))) return NextResponse.json({ error: "Could not save the test." }, { status: 500 })
    return NextResponse.json({ ok: true, status: vc.status })
  }

  const next = applyAnswer(current, answer, now)
  if (!next) return NextResponse.json({ ok: true, unchanged: true })
  if (!(await saveVoiceCheck(channelId, next))) return NextResponse.json({ error: "Could not save your answer — please try again." }, { status: 500 })
  return NextResponse.json({ ok: true, status: next.status })
}
