/**
 * Telegram push on propose — Hermes ↔ Claude bridge (WP3 — Mac Mini executor).
 *
 * When the worker proposes an action (propose_action), the SERVER pushes the
 * formatted proposal straight to Antonio on Telegram so he sees it in <2s even if
 * the Mac Mini is asleep. The Mac Mini's job is the REPLY path (parse
 * APPROVE/REJECT) and the EXECUTE path (claim → approval_execute) — not the
 * first notification. The server never sleeps and has no local state to lose, so
 * server-push is the reliable notify channel.
 *
 * This is the THIRD independent notification channel (defense in depth) alongside
 * the Phase B web-push-to-admin and the CRM team-chat mirror — one failing never
 * loses the proposal.
 *
 * BEST-EFFORT — NEVER throws. A missing token, a Telegram API error, or a network
 * blip must never fail the proposal (which is already safely queued). Mirrors the
 * discipline of sendApprovalNotification.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN        — the bot's API token (same bot Hermes uses).
 *   TELEGRAM_APPROVAL_CHAT_ID — Antonio's chat id (e.g. 307359927).
 */

import { formatApprovalProposal, type ApprovalProposalRow } from "./format-approval-proposal"

/** How long to wait on the Telegram API before giving up (best-effort). */
const TELEGRAM_TIMEOUT_MS = 5000

/**
 * Push a formatted action proposal to Antonio's Telegram chat. Returns true iff
 * the message was accepted by the Telegram API; false on any skip/failure
 * (unconfigured, non-2xx, network error). Never throws.
 */
export async function sendTelegramApprovalNotification(row: ApprovalProposalRow): Promise<boolean> {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN
    const chatId = process.env.TELEGRAM_APPROVAL_CHAT_ID
    if (!token || !chatId) {
      console.warn(
        "[telegram-notify] TELEGRAM_BOT_TOKEN / TELEGRAM_APPROVAL_CHAT_ID not set — Telegram push skipped (proposal still queued; CRM mirror + web push still fire).",
      )
      return false
    }

    const text = formatApprovalProposal(row)
    const url = `https://api.telegram.org/bot${token}/sendMessage`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: controller.signal,
      })
      if (!res.ok) {
        console.warn(`[telegram-notify] sendMessage failed (HTTP ${res.status}) for proposal ${row.id}.`)
        return false
      }
      return true
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    // Best-effort: swallow everything (including AbortError on timeout) so the
    // caller's core path (the proposal) is never affected.
    console.warn("[telegram-notify] error (swallowed):", err instanceof Error ? err.message : String(err))
    return false
  }
}
