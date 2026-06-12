/**
 * Hermes ↔ Claude bridge — Phase C: thread-type tool routing.
 *
 * dev_task: 1a0d1354 (Hermes operating agent) — Phase C (intelligence)
 *
 * A thread carries a `thread_type` (stored on thread_summaries.thread_type).
 * That type decides WHICH of the worker's tools the model gets for that thread,
 * and WHAT output-formatting guidance is appended to its system prompt. Narrowing
 * the tool surface per thread type is defense-in-depth (a client_audit thread can
 * never reach codebase tools; an internal_ops thread can never reach client data)
 * AND a quality lever (a bug_report gets reproduction-step framing).
 *
 * This module is the routing brain. It is name-based and (apart from the
 * convenience `getToolsForThreadType`) pure, so the mapping is trivially
 * unit-testable without a DB or the Anthropic API.
 *
 * Dependency note: `getToolsForThreadType` filters the canonical WORKER_TOOLS
 * list, which lives in worker-tools.ts. worker-tools.ts in turn imports this
 * module's routing functions inside callWorker. That is a deliberate, SAFE
 * import cycle — every cross-reference is deferred to function-call time (never
 * evaluated at module top-level), so initialization order can't bite. Do NOT
 * precompute a `WORKER_TOOLS.filter(...)` at module scope here.
 */

import { WORKER_TOOLS } from "./worker-tools"
import type { ToolDef } from "./tools"

/** The five thread types. Mirrors what callers may store in thread_summaries.thread_type. */
export const THREAD_TYPES = [
  "investigation",
  "action_request",
  "bug_report",
  "client_audit",
  "internal_ops",
] as const

export type ThreadType = (typeof THREAD_TYPES)[number]

/** Safe default when the type is unknown/absent — the full research surface. */
export const DEFAULT_THREAD_TYPE: ThreadType = "investigation"

/** Coerce arbitrary input to a known ThreadType (falls back to the default). */
export function normalizeThreadType(type: unknown): ThreadType {
  return typeof type === "string" && (THREAD_TYPES as readonly string[]).includes(type)
    ? (type as ThreadType)
    : DEFAULT_THREAD_TYPE
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool categories — by NAME (literal arrays, no dependency on WORKER_TOOLS at
// module-eval time). Together CRM + KB/SOP + GMAIL + DRIVE reproduce the
// read-only research subset; CODEBASE + PROPOSE are the two extra capabilities.
// ─────────────────────────────────────────────────────────────────────────────

/** Client-data read tools (CRM). Reaching these means touching client records. */
export const CRM_READ_TOOL_NAMES = [
  "search_accounts",
  "get_account_detail",
  "search_contacts",
  "search_services",
  "search_payments",
  "search_tasks",
  "search_leads",
  "search_deals",
  "search_tax_returns",
  "search_deadlines",
  "search_portal_messages",
  "get_dashboard_stats",
] as const

/** Knowledge base + SOP lookups — system knowledge, not client data. */
export const KB_SOP_TOOL_NAMES = ["search_kb", "get_sop"] as const

/** Gmail read tools — client communications (client data). */
export const GMAIL_TOOL_NAMES = ["gmail_search", "gmail_read", "gmail_read_thread"] as const

/** Drive read tools — client document storage (client data). */
export const DRIVE_TOOL_NAMES = ["drive_search", "drive_list_folder"] as const

/** Repo-source read tools. */
export const CODEBASE_TOOL_NAMES = ["codebase_read", "codebase_search"] as const

/** The single propose (queue-only) capability. */
export const PROPOSE_TOOL_NAME = "propose_action"

/**
 * Decision Memory tools — semantic recall of past decisions (read) + saving a
 * decision learned this conversation (knowledge-only write). Available on the
 * full research surface (investigation + action_request), the bots' dominant
 * threads. The narrow types (client_audit = CRM-only client-facing, internal_ops
 * = no client data, bug_report = trace-only) intentionally keep their contracts
 * and do not get memory.
 */
export const MEMORY_TOOL_NAMES = ["memory_recall", "memory_save"] as const

/**
 * The allow-listed tool NAMES for each thread type. This is the source of truth
 * for routing — `getToolsForThreadType` just filters WORKER_TOOLS through it.
 *
 *  - investigation : full research surface incl. codebase + propose (the default)
 *  - action_request: full surface — MUST be able to propose at least one action
 *  - bug_report    : codebase tools + CRM read tools (trace + check client state)
 *  - client_audit  : CRM read tools ONLY — no code, no propose, client-facing
 *  - internal_ops  : codebase + KB/SOP ONLY — system channel, NO client data
 */
const FULL_RESEARCH_NAMES = [
  ...CRM_READ_TOOL_NAMES,
  ...KB_SOP_TOOL_NAMES,
  ...GMAIL_TOOL_NAMES,
  ...DRIVE_TOOL_NAMES,
  ...CODEBASE_TOOL_NAMES,
  PROPOSE_TOOL_NAME,
  ...MEMORY_TOOL_NAMES,
]

const TOOL_NAMES_BY_THREAD_TYPE: Record<ThreadType, ReadonlySet<string>> = {
  investigation: new Set(FULL_RESEARCH_NAMES),
  action_request: new Set(FULL_RESEARCH_NAMES),
  bug_report: new Set<string>([...CODEBASE_TOOL_NAMES, ...CRM_READ_TOOL_NAMES]),
  client_audit: new Set<string>([...CRM_READ_TOOL_NAMES]),
  internal_ops: new Set<string>([...CODEBASE_TOOL_NAMES, ...KB_SOP_TOOL_NAMES]),
}

/** The allow-listed tool names for a thread type (pure). Unknown → default. */
export function toolNamesForThreadType(type: unknown): ReadonlySet<string> {
  return TOOL_NAMES_BY_THREAD_TYPE[normalizeThreadType(type)]
}

/**
 * Filter WORKER_TOOLS down to the subset allowed for this thread type.
 * The worker receives this list instead of the full WORKER_TOOLS.
 *
 * Referenced only at call time → safe under the worker-tools import cycle.
 */
export function getToolsForThreadType(type: unknown): ToolDef[] {
  const allowed = toolNamesForThreadType(type)
  return WORKER_TOOLS.filter((t) => allowed.has(t.name))
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-type output-formatting guidance appended to WORKER_SYSTEM_PROMPT.
// ─────────────────────────────────────────────────────────────────────────────

const PROMPT_ADDENDUM_BY_THREAD_TYPE: Record<ThreadType, string> = {
  investigation: "",
  action_request: [
    "THREAD TYPE: action_request.",
    "Antonio is asking for something to be DONE, not just researched. After investigating, you MUST call propose_action with at least one concrete proposal (it only queues — nothing runs until Antonio approves). If, after investigating, no action is genuinely warranted, say so explicitly and explain why instead of proposing.",
  ].join("\n"),
  bug_report: [
    "THREAD TYPE: bug_report.",
    "Format your reply as a bug report with these sections:",
    "  1. Summary — one line on the symptom.",
    "  2. Reproduction steps — how to trigger it.",
    "  3. Root cause — trace it with codebase_read / codebase_search and cite file:line.",
    "  4. Suggested fix — what to change (you cannot change code; describe it).",
    "Use the CRM read tools to confirm any affected client/record state.",
  ].join("\n"),
  client_audit: [
    "THREAD TYPE: client_audit.",
    "Produce a CLIENT-FACING audit of the client's state using ONLY the CRM read tools available to you. No code references, no internal jargon, no system internals. Lay out what is in order and what is missing, separating verified facts from gaps you could not confirm.",
  ].join("\n"),
  internal_ops: [
    "THREAD TYPE: internal_ops.",
    "This is a system/operations thread about the platform itself. Do NOT pull client data. Use the codebase and KB/SOP tools only. Answer about how the system works, not about any specific client.",
  ].join("\n"),
}

/** Formatting guidance to append to the worker system prompt for this type (pure). */
export function getPromptAddendumForThreadType(type: unknown): string {
  return PROMPT_ADDENDUM_BY_THREAD_TYPE[normalizeThreadType(type)]
}
