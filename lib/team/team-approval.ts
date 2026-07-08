/**
 * Team Chat in-thread approval completion — the Team equivalent of
 * lib/ai-agent/slack-approval.ts (read it for the full rationale).
 *
 * The worker can only PROPOSE writes (propose_action mints a pending
 * approval_queue row with a 6-digit confirmation_code). In Slack, typing the
 * code back is intercepted BEFORE the LLM and completes the approval. Team Chat
 * had no interception — a code typed here went to the model (the loop risk) or
 * nowhere. This closes it, deterministically, without giving the model any
 * approve capability.
 *
 * Linkage: the Team worker call passes the TEAM thread uuid as callWorker's
 * threadId, and propose_action stamps it into approval_queue.thread_id — so the
 * lookup here is a direct thread_id match. (source_message_id can't be used:
 * it FKs agent_messages, which is Slack-only.)
 *
 * Safety mirrors Slack: admin-only approver, exact-6-digit-only, thread-scoped
 * lookup, refuses ambiguous/absent matches, honors APPROVAL_RAIL_ENABLED,
 * reuses the existing executor, and NEVER falls through to the LLM on error.
 */
import 'server-only'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { currentApprovalEnv } from '@/lib/ai-agent/approval-env'
import { executeApproval, isApprovalRailEnabled } from '@/lib/ai-agent/approval-executor'
import { isSixDigitCode } from '@/lib/ai-agent/slack-approval'

export { isSixDigitCode }

export interface TeamApprovalResult {
  /** True once the code message was consumed here — caller must NOT run @claude on it. */
  handled: boolean
  /** The outcome message to post into the team thread (as Claude). */
  message: string
}

/**
 * Resolve a typed 6-digit code (from an ADMIN, in a team thread) to its single
 * pending proposal and approve+execute it. Caller gates on isSixDigitCode +
 * admin; both re-checked here (defense in depth).
 */
export async function handleTeamApprovalCode(args: {
  code: string
  threadId: string
  isAdminSender: boolean
}): Promise<TeamApprovalResult> {
  const code = args.code.trim()
  if (!isSixDigitCode(code) || !args.isAdminSender) {
    return { handled: false, message: '' }
  }

  try {
    const lane = currentApprovalEnv()

    // The single PENDING proposal in this lane, carrying this code, linked to
    // THIS team thread (approval_queue.thread_id, stamped at propose time).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rows, error } = await (supabaseAdmin as any)
      .from('approval_queue')
      .select('id, tool_name')
      .eq('confirmation_code', code)
      .eq('status', 'pending')
      .eq('env', lane)
      .eq('thread_id', args.threadId)
    if (error) throw error

    const matches = (rows ?? []) as Array<{ id: string; tool_name: string }>
    if (matches.length === 0) {
      return {
        handled: true,
        message: "No pending action in this conversation matches that code — it may have already been approved or expired. Nothing was changed.",
      }
    }
    if (matches.length > 1) {
      return {
        handled: true,
        message: "Two or more pending actions share that code, so I won't guess which to run. Nothing was changed — please re-issue the action you want.",
      }
    }
    const proposal = matches[0]

    // Atomic approve — mirrors approval_decide(approve): flips only a row still
    // pending AND carrying the matched code. A lost race yields 0 rows.
    const nowIso = new Date().toISOString()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: approved, error: updErr } = await (supabaseAdmin as any)
      .from('approval_queue')
      .update({ status: 'approved', decided_by: 'antonio', decided_at: nowIso, updated_at: nowIso })
      .eq('id', proposal.id)
      .eq('status', 'pending')
      .eq('confirmation_code', code)
      .select('id, tool_name')
      .maybeSingle()
    if (updErr) throw updErr
    if (!approved) {
      return { handled: true, message: 'That action was just handled by another process, so I left it as-is. Nothing was changed.' }
    }

    const toolName: string = approved.tool_name
    if (!isApprovalRailEnabled()) {
      return { handled: true, message: `✅ Approved **${toolName}**. Execution is paused right now, so it'll run automatically once that's switched back on.` }
    }

    const result = await executeApproval(proposal.id)
    if (result.status === 'executed') {
      return { handled: true, message: `✅ Done — **${toolName}** approved and executed.` }
    }
    if (result.status === 'failed') {
      return { handled: true, message: `❌ **${toolName}** was approved but failed to run (${result.reason ?? 'see logs'}). Nothing was completed.` }
    }
    return { handled: true, message: `⚠️ **${toolName}** was approved but the executor skipped it (${result.reason ?? 'already handled'}).` }
  } catch (err) {
    // Never fall through to the LLM on error — that's what caused the Slack loop.
    return {
      handled: true,
      message: `⚠️ I hit an error processing that code and did NOT change anything (${err instanceof Error ? err.message : String(err)}). Please check the approval queue.`,
    }
  }
}
