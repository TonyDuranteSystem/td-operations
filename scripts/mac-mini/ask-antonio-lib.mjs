/**
 * ask-antonio shared helpers (pure — unit-tested in
 * tests/unit/ask-antonio-lib.test.ts). The CLI (ask-antonio.mjs) does the I/O;
 * this module holds the string/format logic so it's testable without DB or Slack.
 */

// Antonio's Slack user id. Only his replies count as an answer to a code-task
// question (matches SLACK_USER_ANTONIO in lib/ai-agent/slack-claude.ts). A wrong
// id fails safe — the webhook just won't match his reply, never swallows a
// message wrongly.
export const ANTONIO_SLACK_USER_ID = "U0BAALR4Y4Q"

// How often the CLI polls code_task_questions for the answer.
export const ASK_POLL_MS = 10_000

// CLI self-cap: if no answer arrives within this window the CLI marks the
// question 'expired' and lets the session proceed without it. The runner keeps
// the per-task kill-timer paused while a question is pending, so this cap — NOT
// the task timeout — is what bounds the wait. Override via ASK_ANTONIO_MAX_WAIT_MS.
export const ASK_MAX_WAIT_MS = 30 * 60 * 1000

/**
 * The Slack message body for a question. Mrkdwn; tells Antonio to reply in-thread
 * (the webhook matches his thread reply to this pending question).
 */
export function buildQuestionSlackText(question) {
  const q = (question || "").trim()
  return `❓ *Claude needs your input:*\n${q}\n_Reply in this thread to answer._`
}

/**
 * Strip Slack mention tokens (<@U…>) from Antonio's reply so the stored answer is
 * clean prose. Mirrors the webhook's own cleaning so both sides agree.
 */
export function cleanAnswerText(rawText) {
  return (rawText || "").replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, "").trim()
}

/**
 * Decide what to print/return given the polled row state. Pure so the CLI's
 * control flow is unit-tested. Returns { done, exitCode, output }:
 *   - answered → done, exit 0, the answer text (or a placeholder if empty)
 *   - expired  → done, exit 0, a "no answer" note (session proceeds without it)
 *   - pending/anything else → not done (keep polling)
 */
export function interpretQuestionRow(row) {
  if (!row) return { done: false }
  if (row.status === "answered") {
    const a = (row.answer || "").trim()
    return { done: true, exitCode: 0, output: a || "(Antonio replied with no text.)" }
  }
  if (row.status === "expired") {
    return { done: true, exitCode: 0, output: "(No answer — the question expired. Proceeding without Antonio's input.)" }
  }
  return { done: false }
}
