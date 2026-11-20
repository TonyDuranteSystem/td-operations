/**
 * WEEKLY VOICE-NOTE SELF-TEST (Antonio 2026-11-19/20: "a weekly test voice note with 'Did it play?' Yes/No buttons").
 *
 * Voice notes sent from the CRM travel a long chain (browser recording → conversion on the Mac → WhatsApp) and the last time it broke
 * the only symptom was a client saying "couldn't download audio". Once a week the system sends a short recording to ONE test chat
 * (Antonio's own phone) and asks staff in the WhatsApp page whether it played. A "No" turns the page red.
 *
 * Pure rules only (no I/O) — the cron route and the answer route do the talking. State lives in `wa_bridge_state.voice_check` (jsonb);
 * the feature is OFF until `wa_bridge_state.voice_check_group_id` names the test chat.
 */

export type VoiceCheckStatus = "sent" | "played" | "not_played" | "send_failed"

export interface VoiceCheck {
  /** ISO week the test belongs to, e.g. "2026-W47" */
  week: string
  status: VoiceCheckStatus
  sent_at: string
  client_msg_id?: string
  outbox_id?: string
  answered_at?: string
  /** why it could not be queued (send_failed only) — plain words */
  error?: string
}

export interface VoiceCheckView {
  /** "info" = the test is switched on and nothing has been sent this week yet (a quiet row with "Send a test now") */
  level: "info" | "ask" | "warning" | "problem"
  title: string
  text: string
  /** which buttons the page shows */
  actions: Array<"played" | "not_played" | "resend">
  sentAt: string
}

/** The ISO week a moment falls in ("2026-W47"). Weeks start on Monday; the year is the ISO week-year. */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day) // the Thursday of this week decides the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/** Read the stored jsonb defensively: anything unexpected = no check on record. */
export function parseVoiceCheck(raw: unknown): VoiceCheck | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const status = r.status
  if (status !== "sent" && status !== "played" && status !== "not_played" && status !== "send_failed") return null
  if (typeof r.week !== "string" || typeof r.sent_at !== "string") return null
  const out: VoiceCheck = { week: r.week, status, sent_at: r.sent_at }
  if (typeof r.client_msg_id === "string") out.client_msg_id = r.client_msg_id
  if (typeof r.outbox_id === "string") out.outbox_id = r.outbox_id
  if (typeof r.answered_at === "string") out.answered_at = r.answered_at
  if (typeof r.error === "string") out.error = r.error.slice(0, 300)
  return out
}

export interface SendDecisionInput {
  /** `wa_bridge_state.voice_check_group_id` — null = the feature is off */
  testChatId: string | null | undefined
  /** from classifyBridge — only "ok" may send */
  health: string
  sendMode: string | null | undefined
  current: VoiceCheck | null
  now: Date
}

/** Should the weekly job send a test now? One test per ISO week, only when the line is healthy and sending is live. */
export function decideVoiceCheckSend(i: SendDecisionInput): { send: boolean; reason: string } {
  if (!i.testChatId) return { send: false, reason: "off" }
  if (i.health !== "ok") return { send: false, reason: "bridge_not_healthy" }
  if (i.sendMode !== "live") return { send: false, reason: "sending_not_live" }
  if (i.current && i.current.week === isoWeekKey(i.now)) return { send: false, reason: "already_this_week" }
  return { send: true, reason: "due" }
}

/** Minutes to let the recording arrive before asking "did it play?". */
export const VOICE_CHECK_ARRIVAL_MINUTES = 2
/** A test nobody answered after this long is shown as a reminder. */
export const VOICE_CHECK_REMIND_HOURS = 24

/** What the WhatsApp page should show for the stored check (null = nothing to say). `enabled` = a test chat is chosen. */
export function voiceCheckView(vc: VoiceCheck | null, now: Date, enabled = false): VoiceCheckView | null {
  if (!vc || vc.week !== isoWeekKey(now)) {
    // Switched on, but no test has gone out THIS week (just switched on, or the weekly job has not run yet): offer one now.
    // Not shown once this week's test exists, and never when the feature is off. An older unanswered "No" still shows (below).
    if (enabled && (!vc || vc.status === "played")) {
      return {
        level: "info",
        title: "Weekly voice-note test is on",
        text: "A short test voice note goes to your test phone every Monday, and you answer Yes or No here. You can send one now to try it.",
        actions: ["resend"],
        sentAt: vc?.sent_at ?? now.toISOString(),
      }
    }
    if (!vc) return null
  }
  const sentMs = Date.parse(vc.sent_at)
  if (Number.isNaN(sentMs)) return null
  if (vc.status === "played") return null
  if (vc.status === "not_played") {
    return {
      level: "problem",
      title: "Voice notes may not be playing",
      text: "You said the weekly test voice note did NOT play on the phone, so voice notes sent from the CRM may not play for clients either. Reply to a client by typing until this is fixed, then press \"Send a new test\" to check again. If the program on the Mac was just updated, that is the first thing to suspect.",
      actions: ["resend"],
      sentAt: vc.sent_at,
    }
  }
  if (vc.status === "send_failed") {
    return {
      level: "warning",
      title: "The weekly voice-note test could not be sent",
      text: `${vc.error ? vc.error + " " : ""}The test did not go out, so voice notes were not checked this week.`,
      actions: ["resend"],
      sentAt: vc.sent_at,
    }
  }
  // status === "sent": waiting for a person
  const ageMin = (now.getTime() - sentMs) / 60_000
  if (ageMin < VOICE_CHECK_ARRIVAL_MINUTES) return null
  const overdue = ageMin >= VOICE_CHECK_REMIND_HOURS * 60
  return {
    level: overdue ? "warning" : "ask",
    title: overdue ? "Weekly voice-note test — still waiting for your answer" : "Weekly voice-note test",
    text: "A short test voice note was sent to your test phone. Did it arrive and play?",
    actions: ["played", "not_played"],
    sentAt: vc.sent_at,
  }
}

/** The state after a person answers. Only an unanswered "sent" check can be answered; anything else is left as it is. */
export function applyAnswer(vc: VoiceCheck | null, answer: "played" | "not_played", now: Date): VoiceCheck | null {
  if (!vc || vc.status !== "sent") return null
  return { ...vc, status: answer, answered_at: now.toISOString() }
}
