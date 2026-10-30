/**
 * The COMPLETE set of options the payment investigator hands to the AI worker — in one pure function so a
 * test can pin it. Same pattern as the WhatsApp surface (lib/inbox/whatsapp-worker-context.ts): every other
 * enable* flag stays off, so there is no send tool, no raw SQL, no CRM note write, no full-tool reach.
 *
 * The investigator reads text written by strangers (emails, bank lines, earlier notes), so it must not hold
 * a tool that WRITES what later runs read: memory_save (lessons that are auto-recalled into every worker
 * prompt), nor one that exposes source code, nor the action-proposal tool.
 */
import type { CallWorkerOptions } from "@/lib/ai-agent/worker-tools"
import { INVESTIGATOR_SYSTEM_PROMPT } from "@/lib/finance/feed-investigation"

export const INVESTIGATOR_SURFACE = "bank-feed-investigator"

/** Tools in the base worker list that write, or expose code, removed for this surface. */
export const INVESTIGATOR_EXCLUDED_TOOLS = ["memory_save", "codebase_read", "codebase_search", "propose_action"] as const

/** Steps the model may take. Each step is a model call; the loop also stops on its own time budget. */
export const INVESTIGATOR_MAX_ITERATIONS = 10

export function buildInvestigatorWorkerOptions(): Partial<CallWorkerOptions> {
  return {
    surface: INVESTIGATOR_SURFACE,
    systemPromptOverride: INVESTIGATOR_SYSTEM_PROMPT,
    maxIterations: INVESTIGATOR_MAX_ITERATIONS,
    excludeTools: [...INVESTIGATOR_EXCLUDED_TOOLS],
    // The reply is a result block parsed by code: no chat answer guards, no wall report, no lesson auto-recall.
    machineOutput: true,
    // Read-only additions: the Bank Feed lookup, call transcripts and tagged client conversations.
    enableBankFeedRead: true,
    enableCallReads: true,
    enableClientThreadRead: true,
  }
}
