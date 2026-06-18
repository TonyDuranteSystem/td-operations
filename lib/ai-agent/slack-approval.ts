/**
 * Slack in-channel approval completion (loop fix).
 *
 * The Slack worker can only PROPOSE writes (propose_action mints a pending
 * approval_queue row with a fresh 6-digit confirmation_code). It has no approval
 * tool, and nothing on the Slack side consumed a typed code — so typing the code
 * back re-invoked the LLM, which re-proposed, minting a new code → infinite loop.
 *
 * This module closes that loop deterministically, WITHOUT giving the model any
 * approve capability:
 *   - processSlackEvent diverts a message that is EXACTLY a 6-digit code AND from
 *     the authorized approver (Antonio) to handleSlackApprovalCode — the LLM is
 *     never called for it, so no new proposal can ever be minted.
 *   - handleSlackApprovalCode finds the single pending proposal linked to THIS
 *     Slack thread (via approval_queue.source_message_id → agent_messages, stamped
 *     at propose time), atomically approves it (mirroring approval_decide's
 *     pending→approved + code guards), then runs it through the EXISTING executor
 *     (executeApproval) and reports the outcome.
 *
 * Safety: Antonio-only (isAuthorizedApprover), exact-6-digit-only (isSixDigitCode),
 * thread-scoped lookup, refuses ambiguous/absent matches, honors the
 * APPROVAL_RAIL_ENABLED kill switch. Reuses lib/ai-agent/approval-executor.ts —
 * it does NOT duplicate the run/claim/finalize logic.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { currentApprovalEnv } from "./approval-env"
import { executeApproval, isApprovalRailEnabled } from "./approval-executor"

/**
 * The only Slack user permitted to complete an approval in-channel. Overridable
 * via SLACK_APPROVER_USER_ID for rotation; default is Antonio's Slack user id
 * (verified 2026-06-18 against agent_messages.context_json.slack_user_id).
 */
export const ANTONIO_SLACK_USER_ID =
  process.env.SLACK_APPROVER_USER_ID?.trim() || "U0BAALR4Y4Q"

const SIX_DIGIT = /^\d{6}$/

/** Pure: is this message body EXACTLY a 6-digit confirmation code (trimmed)? */
export function isSixDigitCode(body: string | null | undefined): boolean {
  return SIX_DIGIT.test((body ?? "").trim())
}

/** Pure: may this Slack user complete an approval in-channel? */
export function isAuthorizedApprover(slackUserId: string | null | undefined): boolean {
  return !!slackUserId && slackUserId === ANTONIO_SLACK_USER_ID
}

/** Pure: conversation scope key — mirrors slackScopeKey in slack-claude.ts. */
export function approvalScopeKey(channelId: string, threadTs: string | null | undefined): string {
  return threadTs ? `${channelId}:${threadTs}` : channelId
}

export interface SlackApprovalResult {
  /** True once the code message was consumed here — caller must NOT pass it to the LLM. */
  handled: boolean
  /** The message to post back in the Slack thread. */
  message: string
}

/**
 * Resolve a typed 6-digit code (from Antonio, in a Slack thread) to its single
 * pending proposal and approve+execute it. Always returns handled=true for an
 * authorized code message — even on no-match/ambiguous/error — so the caller
 * never falls through to the LLM (which is what caused the loop).
 */
export async function handleSlackApprovalCode(args: {
  code: string
  channelId: string
  threadTs: string | null | undefined
  slackUserId: string | null | undefined
}): Promise<SlackApprovalResult> {
  const code = args.code.trim()

  // Defense in depth: the caller already gates on these, but never approve for a
  // non-Antonio user or a non-code body even if mis-invoked.
  if (!isSixDigitCode(code) || !isAuthorizedApprover(args.slackUserId)) {
    return { handled: false, message: "" }
  }

  try {
    const lane = currentApprovalEnv()
    const scopeKey = approvalScopeKey(args.channelId, args.threadTs)

    // 1) agent_messages rows in THIS Slack thread (the proposal's source_message_id
    //    points at the message that triggered propose_action — same thread scope).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: msgs, error: msgErr } = await (supabaseAdmin as any)
      .from("agent_messages")
      .select("id")
      .filter("context_json->>slack_scope_key", "eq", scopeKey)
    if (msgErr) throw msgErr

    const msgIds = ((msgs ?? []) as Array<{ id: string }>).map((m) => m.id)
    if (msgIds.length === 0) {
      return {
        handled: true,
        message: "I couldn't find any action linked to this thread, so there's nothing to approve with that code. Nothing was changed.",
      }
    }

    // 2) The single PENDING proposal in this lane, carrying this code, linked to a
    //    message in this thread.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rows, error: rowErr } = await (supabaseAdmin as any)
      .from("approval_queue")
      .select("id, tool_name, status, confirmation_code")
      .eq("confirmation_code", code)
      .eq("status", "pending")
      .eq("env", lane)
      .in("source_message_id", msgIds)
    if (rowErr) throw rowErr

    const matches = (rows ?? []) as Array<{ id: string; tool_name: string }>
    if (matches.length === 0) {
      return {
        handled: true,
        message: "No pending action in this thread matches that code — it may have already been approved or expired. Nothing was changed.",
      }
    }
    if (matches.length > 1) {
      return {
        handled: true,
        message: "Two or more pending actions share that code, so I won't guess which to run. Nothing was changed — please re-issue the action you want.",
      }
    }

    const proposal = matches[0]

    // 3) Atomic approve — mirrors approval_decide(approve): only flips a row still
    //    pending AND carrying the matched code. A lost race yields 0 rows.
    const nowIso = new Date().toISOString()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: approved, error: updErr } = await (supabaseAdmin as any)
      .from("approval_queue")
      .update({ status: "approved", decided_by: "antonio", decided_at: nowIso, updated_at: nowIso })
      .eq("id", proposal.id)
      .eq("status", "pending")
      .eq("confirmation_code", code)
      .select("id, tool_name")
      .maybeSingle()
    if (updErr) throw updErr
    if (!approved) {
      return {
        handled: true,
        message: "That action was just handled by another process, so I left it as-is. Nothing was changed.",
      }
    }

    const toolName: string = approved.tool_name

    // 4) Execute now via the existing executor — UNLESS the kill switch is off.
    if (!isApprovalRailEnabled()) {
      return {
        handled: true,
        message: `✅ Approved *${toolName}*. Execution is paused right now, so it'll run automatically once that's switched back on.`,
      }
    }

    const result = await executeApproval(proposal.id)
    if (result.status === "executed") {
      return { handled: true, message: `✅ Done — *${toolName}* approved and executed.` }
    }
    if (result.status === "failed") {
      return {
        handled: true,
        message: `❌ *${toolName}* was approved but failed to run (${result.reason ?? "see logs"}). I've flagged it — nothing was completed.`,
      }
    }
    // skipped — already claimed/decided/expired between approve and execute.
    return {
      handled: true,
      message: `⚠️ *${toolName}* was approved but the executor skipped it (${result.reason ?? "already handled"}).`,
    }
  } catch (err) {
    // Never fall through to the LLM on error — that's what caused the loop.
    return {
      handled: true,
      message: `⚠️ I hit an error processing that code and did NOT change anything (${err instanceof Error ? err.message : String(err)}). Please check the approval queue.`,
    }
  }
}
