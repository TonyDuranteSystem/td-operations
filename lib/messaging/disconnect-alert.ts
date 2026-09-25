/**
 * Staff email when a WhatsApp connection drops.
 *
 * This is a system/infra event with no client or account to scope it to, so
 * it does NOT fit the To-Do board's emitActionNeeded() (every ActEvent there
 * requires a contact_id or account_id). A direct staff email is the same
 * "make sure someone finds out" mechanism this codebase already uses for
 * workflow SLA escalations (app/api/cron/workflow-sla-check/route.ts) — same
 * RFC 2047 subject encoding (R041), same best-effort/non-fatal contract: a
 * failed alert must never break the webhook response 2Chat is waiting on.
 */

import { escapeHtml } from "@/lib/html-escape"

const FROM_HEADER = "Tony Durante CRM <support@tonydurante.us>"
const DEFAULT_ALERT_EMAIL = "support@tonydurante.us"

export interface DisconnectAlertParams {
  channelName: string
  reason: string
  notifyEmail?: string
  /** What to do about it. Defaults to the 2Chat re-scan wording (the original caller). */
  hint?: string
  /** Footer attribution. Defaults to the 2Chat webhook. */
  source?: string
}

const DEFAULT_HINT = "open 2Chat and re-scan the QR code for this number."

/** Pure — builds the RFC 2822 raw message. Split out so it's unit-testable without Gmail. */
export function buildDisconnectAlertEmail(params: DisconnectAlertParams): { to: string; raw: string } {
  const to = params.notifyEmail?.trim() || DEFAULT_ALERT_EMAIL
  const subject = `[WhatsApp] Connection dropped: ${params.channelName}`
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">
      <h2 style="color:#b91c1c;margin:0 0 12px 0">A WhatsApp number disconnected</h2>
      <table style="border-collapse:collapse;margin:12px 0">
        <tr><td style="padding:4px 8px;font-weight:bold">Number</td><td style="padding:4px 8px">${escapeHtml(params.channelName)}</td></tr>
        <tr><td style="padding:4px 8px;font-weight:bold">Reason</td><td style="padding:4px 8px">${escapeHtml(params.reason)}</td></tr>
      </table>
      <p>Messages to this number will not be received or sendable until it's reconnected — ${escapeHtml(params.hint ?? DEFAULT_HINT)}</p>
      <p style="color:#6b7280;font-size:12px">Sent automatically by ${escapeHtml(params.source ?? "the 2Chat webhook")}.</p>
    </div>`
  const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
  const raw = [
    `From: ${FROM_HEADER}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html).toString("base64"),
  ].join("\r\n")
  return { to, raw: Buffer.from(raw).toString("base64url") }
}

/** Best-effort — a failed alert must not break the webhook's response to 2Chat. */
export async function sendDisconnectAlertEmail(params: DisconnectAlertParams): Promise<void> {
  try {
    const { gmailPost } = await import("@/lib/gmail")
    const { raw } = buildDisconnectAlertEmail(params)
    await gmailPost("/messages/send", { raw })
  } catch (err) {
    console.warn(
      `[disconnect-alert] failed to send for ${params.channelName}:`,
      err instanceof Error ? err.message : String(err)
    )
  }
}
