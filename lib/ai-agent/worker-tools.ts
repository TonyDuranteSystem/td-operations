/**
 * Hermes ↔ Claude bridge worker (Phase 1: research/discussion rail)
 *
 * dev_task: 1a0d1354
 *
 * Two responsibilities:
 *   1. WORKER_TOOLS — a curated READ-ONLY subset of AGENT_TOOLS that the
 *      worker exposes to claude-sonnet-4-6. Every tool here must be a
 *      query/search/read; no sends, no mutations, no DB writes.
 *   2. callWorker(...) — a self-contained Anthropic Messages API call that
 *      mirrors the in-dashboard provider's tool-use loop but uses the worker
 *      subset + a worker-specific system prompt. We don't reuse callAgent in
 *      providers.ts because that function hardcodes the full AGENT_TOOLS
 *      and the SYSTEM_PROMPT meant for the in-dashboard assistant.
 *
 * SAFETY (defense-in-depth):
 *   - Sonnet only sees WORKER_TOOLS in its tool list, so it cannot invoke
 *     a write tool by name.
 *   - executeWorkerTool() additionally rejects any tool name outside the
 *     allow-list before delegating to the shared executeTool implementation
 *     in lib/ai-agent/tools.ts.
 *   - run_sql_query is INTENTIONALLY excluded — search_* tools cover the
 *     research surface, raw SQL is unnecessary and adds risk.
 */

import { createHash, randomUUID } from "crypto"
import { AGENT_TOOLS, executeTool, type ToolDef } from "./tools"
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  APPROVABLE_TOOL_NAMES,
  isApprovableTool,
  validateToolParams,
  computeParamsHash,
} from "./approvable-tools"
import { normalizeToolParams } from "./enum-normalization"
import { sendApprovalNotification } from "./approval-notifications"
import { sendTelegramApprovalNotification } from "./telegram-notify"
import { currentApprovalEnv } from "./approval-env"
import {
  readCodebaseFile,
  searchCodebase,
  CODEBASE_READ_DESCRIPTION,
  CODEBASE_SEARCH_DESCRIPTION,
} from "@/lib/mcp/tools/codebase-read"
import {
  getToolsForThreadType,
  getPromptAddendumForThreadType,
  normalizeThreadType,
  DEFAULT_THREAD_TYPE,
  type ThreadType,
} from "./thread-routing"
import { buildThreadContext } from "./thread-context"
import { createThreadSummary, getThreadSummary, resolveThread } from "./thread-summaries"

/**
 * The complete read-only allow-list. Adding a tool here is a deliberate
 * security decision — review the underlying handler to make sure it cannot
 * write, send, or otherwise affect state. Tests assert this set has no
 * write-shaped tool name.
 */
export const WORKER_READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  // CRM read tools
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
  // Knowledge & SOP
  "search_kb",
  "get_sop",
  // Gmail read tools
  "gmail_search",
  "gmail_read",
  "gmail_read_thread",
  // Drive read tools
  "drive_search",
  "drive_list_folder",
])

/**
 * propose_action — the ONLY non-read tool the worker gets (Phase 2, Slice 1).
 *
 * It does NOT execute anything. It validates a proposed action against the
 * approvable allow-list + that tool's schema, then writes a status='pending'
 * row into approval_queue for Antonio to approve later. Execution is a separate
 * slice — there is no execute path in Slice 1.
 */
export const PROPOSE_ACTION_TOOL: ToolDef = {
  name: "propose_action",
  description: [
    "Propose an action for Antonio to approve. This does NOT run the action — it queues it.",
    "Use this whenever the research request implies a side-effecting action (sending an email, creating/updating a CRM record, advancing a stage, moving/uploading a Drive file, logging a conversation, saving a memory).",
    "Do NOT describe-only: if an action is implied, propose it here. It will sit as 'pending' until Antonio approves it on the approval rail — nothing happens until then.",
    `Allowed tool_name values: ${Array.from(APPROVABLE_TOOL_NAMES).join(", ")}.`,
    "params must match that tool's own parameters. Include a short rationale explaining why the action is warranted.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      tool_name: {
        type: "string",
        description: `The action tool to propose. One of: ${Array.from(APPROVABLE_TOOL_NAMES).join(", ")}.`,
      },
      params: {
        type: "object",
        description: "The exact params the action would run with — must match the named tool's schema.",
      },
      rationale: {
        type: "string",
        description: "Short plain-English reason this action is warranted (surfaced on the approval card).",
      },
      idempotency_key: {
        type: "string",
        description: "Optional dedup key. Re-proposing with the same key returns the existing pending/approved row instead of creating a duplicate.",
      },
    },
    required: ["tool_name", "params"],
  },
}

/**
 * codebase_read / codebase_search — read-only repo-source access for the worker
 * so it can trace a research question into the actual code, not just the DB.
 *
 * These are NOT AGENT_TOOLS (they live as MCP tools in lib/mcp/tools/
 * codebase-read.ts). They're wired into the worker as standalone ToolDefs and
 * dispatched explicitly in executeWorkerTool — they never touch executeTool.
 * Both are strictly read-only (repo-scoped, env/secrets/deps blocked, 100KB cap,
 * binary refused — all enforced in codebase-read.ts).
 */
export const CODEBASE_READ_TOOL: ToolDef = {
  name: "codebase_read",
  description: CODEBASE_READ_DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the repo root." },
    },
    required: ["path"],
  },
}

export const CODEBASE_SEARCH_TOOL: ToolDef = {
  name: "codebase_search",
  description: CODEBASE_SEARCH_DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "String or JavaScript regular expression to search for." },
      directory: { type: "string", description: "Optional repo-relative directory to limit the search (e.g. 'lib/portal')." },
      extension: { type: "string", description: "Optional file extension filter, no dot (e.g. 'tsx')." },
    },
    required: ["pattern"],
  },
}

/**
 * Tools handed to sonnet at request time: the read-only research subset PLUS
 * propose_action (which only queues, never executes) PLUS the read-only
 * codebase tools (so the worker can trace into source).
 */
export const WORKER_TOOLS: ToolDef[] = [
  ...AGENT_TOOLS.filter((t) => WORKER_READ_ONLY_TOOL_NAMES.has(t.name)),
  PROPOSE_ACTION_TOOL,
  CODEBASE_READ_TOOL,
  CODEBASE_SEARCH_TOOL,
]

/**
 * Mint a 6-digit confirmation code for a proposal (WP1). Antonio must type this
 * exact code to approve the proposal (approval_decide(approve) verifies it), so
 * an approval can't fire by accident or by typo'ing the wrong proposal id.
 * Range 100000–999999 — always exactly 6 digits, never zero-padded.
 */
export function generateConfirmationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

/**
 * Queue a proposed action into approval_queue. NEVER executes — only inserts a
 * pending row (Phase 2, Slice 1). Exported for unit tests.
 *
 * Rejects (returns an error string, no insert) when:
 *   - tool_name is not in APPROVABLE_TOOL_NAMES, or
 *   - params don't validate against that tool's schema.
 *
 * Idempotency: if idempotency_key matches an existing row whose status is
 * pending or approved, returns that row instead of inserting a duplicate.
 */
export async function proposeAction(input: {
  tool_name?: unknown
  params?: unknown
  rationale?: unknown
  idempotency_key?: unknown
  thread_id?: unknown
  batch_id?: unknown
}): Promise<string> {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : ""
  // Normalize enum-backed params to their canonical DB value BEFORE validation +
  // hashing, so a proposal with 'medium'/'todo' is accepted (→ 'Normal'/'To Do')
  // and the stored params (and params_hash) reflect exactly what will execute.
  const params = normalizeToolParams(toolName, input.params ?? {})
  const rationale = typeof input.rationale === "string" ? input.rationale : null
  const idempotencyKey = typeof input.idempotency_key === "string" && input.idempotency_key.length > 0
    ? input.idempotency_key
    : null
  // Optional thread linkage — ties the proposal to a conversation thread. Only a
  // non-empty string is accepted; anything else stores NULL (no thread).
  const threadId = typeof input.thread_id === "string" && input.thread_id.length > 0
    ? input.thread_id
    : null
  // Optional batch grouping — multiple proposals minted together share one
  // batch_id so they're queryable as a unit (Phase D, batch_propose). NULL = solo.
  const batchId = typeof input.batch_id === "string" && input.batch_id.length > 0
    ? input.batch_id
    : null

  // 1) Allow-list check — a tool not in the set can never be proposed.
  if (!isApprovableTool(toolName)) {
    return `❌ "${toolName}" is not an approvable action. Allowed: ${Array.from(APPROVABLE_TOOL_NAMES).join(", ")}.`
  }

  // 2) Schema check — reject a malformed proposal at propose time.
  const validation = validateToolParams(toolName, params)
  if (!validation.ok) {
    return `❌ Invalid params for "${toolName}": ${validation.errors.join(" ")}`
  }

  // 3) Idempotency — return an existing pending/approved row rather than dup.
  if (idempotencyKey) {
    const { data: existing } = await (supabaseAdmin as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (col: string, val: string) => { maybeSingle: () => Promise<{ data: ApprovalQueueRow | null }> }
        }
      }
    })
      .from("approval_queue")
      .select("id, tool_name, status, created_at")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle()

    if (existing && (existing.status === "pending" || existing.status === "approved")) {
      return [
        `✅ Duplicate idempotency_key — returning existing proposal (no new row).`,
        `   id=${existing.id}`,
        `   tool_name=${existing.tool_name}`,
        `   status=${existing.status}`,
        `   created_at=${existing.created_at}`,
      ].join("\n")
    }
  }

  // 4) Insert the pending proposal. NOTHING EXECUTES.
  const paramsHash = computeParamsHash(params)
  // 6-digit confirmation code Antonio must type to approve (WP1). Bound to this
  // specific proposal so approval can't fire by accident or wrong-id typo.
  const confirmationCode = generateConfirmationCode()
  const { data, error } = await (supabaseAdmin as unknown as {
    from: (t: string) => {
      insert: (row: Record<string, unknown>) => {
        select: (c: string) => { single: () => Promise<{ data: ApprovalQueueRow | null; error: { code?: string; message?: string } | null }> }
      }
    }
  })
    .from("approval_queue")
    .insert({
      requested_by: "worker",
      tool_name: toolName,
      params,
      params_hash: paramsHash,
      rationale,
      idempotency_key: idempotencyKey,
      thread_id: threadId,
      batch_id: batchId,
      // Lane tag: which approval environment will execute this (Phase D). Defaults
      // to 'production' on every real deployment unless APPROVAL_ENV carves a lane.
      env: currentApprovalEnv(),
      confirmation_code: confirmationCode,
      status: "pending",
    })
    .select("id, tool_name, status, params_hash, confirmation_code, created_at")
    .single()

  if (error) {
    // 23505 = unique_violation — an idempotency_key race.
    if (error.code === "23505") {
      return `⚠️ A proposal with this idempotency_key already exists (race). Call approval_list to find it.`
    }
    return `❌ propose_action failed to queue: ${error.message ?? "unknown error"}`
  }
  if (!data) return `❌ propose_action: insert returned no row.`

  // Heads-up to the CRM team chat so a proposal is visible to staff even before
  // Hermes surfaces it on Telegram (Phase B, deliverable #4). Best-effort — the
  // helper never throws, so a notification failure never fails the proposal.
  await sendApprovalNotification(
    { id: data.id, tool_name: toolName, params, rationale },
    "proposed",
  )

  // WP3: also push the proposal straight to Antonio on Telegram (server-side) so
  // he sees it in seconds even if the Mac Mini is asleep. Best-effort, never
  // throws, skips cleanly when TELEGRAM_BOT_TOKEN/CHAT_ID are unset. Third
  // independent channel alongside the CRM mirror + web push.
  await sendTelegramApprovalNotification({
    id: data.id,
    tool_name: toolName,
    params,
    rationale,
    confirmation_code: data.confirmation_code ?? confirmationCode,
  })

  return [
    `✅ Action proposed and queued for approval (NOT executed).`,
    `   id=${data.id}`,
    `   tool_name=${data.tool_name}`,
    `   status=${data.status}`,
    `   params_hash=${data.params_hash}`,
    `   confirmation_code=${data.confirmation_code ?? confirmationCode}`,
    `   created_at=${data.created_at}`,
    "",
    `This will run only after Antonio approves it with the confirmation code. Nothing has happened yet.`,
  ].join("\n")
}

/**
 * Propose several actions as ONE batch — they share a single batch_id so they're
 * queryable as a unit (approval_list(batch_id=…)). Phase D UX prep: there is NO
 * batch approve/reject yet — each proposal is still decided individually; this
 * only establishes the grouping.
 *
 * Mints a fresh batch_id (or reuses opts.batch_id), then routes every proposal
 * through proposeAction, so allow-list/schema validation, enum normalization,
 * hashing, idempotency and the propose notification all still apply per row.
 * Returns the batch_id + each proposal's result string (in input order).
 */
export async function batchPropose(
  proposals: Array<{
    tool_name?: unknown
    params?: unknown
    rationale?: unknown
    idempotency_key?: unknown
    thread_id?: unknown
  }>,
  opts: { batch_id?: string } = {},
): Promise<{ batch_id: string; count: number; results: string[] }> {
  const batchId =
    typeof opts.batch_id === "string" && opts.batch_id.length > 0 ? opts.batch_id : randomUUID()
  const results: string[] = []
  for (const p of proposals ?? []) {
    results.push(await proposeAction({ ...p, batch_id: batchId }))
  }
  return { batch_id: batchId, count: results.length, results }
}

interface ApprovalQueueRow {
  id: string
  tool_name: string
  status: string
  params_hash?: string
  confirmation_code?: string | null
  created_at: string
}

/**
 * Wrapped execute that hard-rejects any tool name not permitted for the worker.
 * Defense-in-depth: even if sonnet somehow names a tool outside its visible
 * list, this returns a clear error instead of delegating to executeTool.
 *
 * propose_action is handled here (it queues, never executes); the read-only
 * subset delegates to executeTool; everything else is rejected.
 */
export async function executeWorkerTool(name: string, params: Record<string, unknown>): Promise<string> {
  if (name === "propose_action") {
    return proposeAction(params)
  }
  // Read-only repo-source tools — dispatched directly (not via executeTool;
  // they're not AGENT_TOOLS). Repo-scoped + env/secrets/deps blocked in
  // lib/mcp/tools/codebase-read.ts.
  if (name === "codebase_read") {
    return readCodebaseFile(typeof params.path === "string" ? params.path : "")
  }
  if (name === "codebase_search") {
    return searchCodebase(
      typeof params.pattern === "string" ? params.pattern : "",
      typeof params.directory === "string" ? params.directory : undefined,
      typeof params.extension === "string" ? params.extension : undefined,
    )
  }
  if (!WORKER_READ_ONLY_TOOL_NAMES.has(name)) {
    return `❌ Tool "${name}" is not permitted in the Hermes-bridge worker (read-only by design).`
  }
  return executeTool(name, params as Record<string, unknown>)
}

/**
 * Worker-specific system prompt. The in-dashboard SYSTEM_PROMPT is tailored
 * to the staff chat UI; here we frame the model as a research assistant
 * responding to a Telegram-relayed research request from Antonio.
 */
export const WORKER_SYSTEM_PROMPT = [
  "You are a server-side research worker for the Hermes ↔ Claude bridge at Tony Durante LLC.",
  "A message has arrived from Hermes — Antonio's Telegram assistant — relaying a research question from Antonio.",
  "",
  "Your job:",
  "  1. Investigate using the read-only tools available to you (CRM search/get, Gmail read, Drive list, KB/SOP search, and codebase_read/codebase_search to trace a question into the actual repo source).",
  "  2. Verify every factual claim against a fresh tool call. NEVER assume column names, schemas, client state, or past actions.",
  "  3. Reply with concise, plain-English findings suitable for Hermes to relay back to Antonio on Telegram.",
  "  4. When an action is implied (send an email, create/update a record, advance a stage, move/upload a Drive file, log a conversation, save a memory), call propose_action — do NOT describe-only. propose_action does NOT run the action; it queues a pending proposal that does nothing until Antonio approves it on the approval rail. You still cannot execute, send, or mutate anything directly — propose_action is your only non-read tool, and it only queues.",
  "",
  "Output discipline:",
  "  - Plain English, no internal jargon.",
  "  - Show citations to file paths, table+column names, or doc slugs when the finding depends on them.",
  "  - Separate verified facts from inference. Flag anything you couldn't verify.",
  "  - Keep it short enough for a Telegram chat — Hermes will summarize further if needed.",
].join("\n")

/**
 * Version fingerprint of the worker's base system prompt — SHA-256 of
 * WORKER_SYSTEM_PROMPT, computed once at module load (Phase D). Stored on each
 * thread at creation (thread_summaries.prompt_version) so we can later
 * reconstruct what base instructions the worker had during any thread. The
 * per-thread-type addendum is NOT folded in: thread_type is stored alongside and
 * getPromptAddendumForThreadType(type) is deterministic, so base-hash + type
 * fully reconstruct the instruction set.
 */
export const WORKER_PROMPT_VERSION: string = createHash("sha256")
  .update(WORKER_SYSTEM_PROMPT)
  .digest("hex")

// ─────────────────────────────────────────────────────────────────────────────
// callWorker — Claude (sonnet-4-6) tool-use loop, scoped to WORKER_TOOLS
// ─────────────────────────────────────────────────────────────────────────────

interface WorkerResponse {
  reply: string
  toolsUsed: string[]
}

// Default max tool-use iterations. Configurable via AGENT_MAX_TOOL_LOOPS env var
// (shared with the in-dashboard provider in providers.ts); callWorker callers may
// also override per-request (e.g. agent_messages.context_json.max_iterations).
const DEFAULT_MAX_TOOL_LOOPS = Number(process.env.AGENT_MAX_TOOL_LOOPS) || 8
const ANTHROPIC_TIMEOUT_MS = 240_000 // per-call ceiling; raised from 55s so max_tokens=16384 is usable for long pure-text responses. Stays under cron route's maxDuration=300 with 60s buffer.

export interface CallWorkerOptions {
  /**
   * Thread this message belongs to. When set, the worker is given the thread's
   * prior conversation as context, a tool subset filtered by the thread's type,
   * and the thread is resolved (durable summary written) after the reply.
   */
  threadId?: string | null
  /** The agent_messages id being answered — excluded from the prepended context. */
  messageId?: string | null
  /**
   * Per-request override for the worker's max tool-use loops. Falls back to the
   * AGENT_MAX_TOOL_LOOPS env var, then 8. The cron route derives this from the
   * message's context_json.max_iterations.
   */
  maxIterations?: number
}

/** First non-empty line of the request body, capped — used as the thread title. */
export function deriveThreadTitle(body: string): string {
  const firstLine = (body ?? "")
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean) ?? ""
  return firstLine.slice(0, 80)
}

/**
 * One-paragraph extractive summary of the worker's reply (whitespace-collapsed,
 * capped at 600 chars). Deterministic — no second LLM call just to compress.
 */
export function oneParagraphSummary(reply: string): string {
  const collapsed = (reply ?? "").replace(/\s+/g, " ").trim()
  return collapsed.length > 600 ? `${collapsed.slice(0, 600)}…` : collapsed
}

/**
 * The raw sonnet tool-use loop, parameterized by the tool list + system prompt
 * so callWorker can hand it a thread-type-filtered subset and an augmented prompt.
 *
 * Mirrors callClaude() in lib/ai-agent/providers.ts but uses executeWorkerTool()
 * for dispatch (the extra allow-list guard). Returns reachedMaxLoops=true only
 * when the loop is exhausted without a final answer.
 */
async function runWorkerLoop(
  userBody: string,
  tools: ToolDef[],
  systemPrompt: string,
  maxIterations?: number,
): Promise<{ reply: string; toolsUsed: string[]; reachedMaxLoops: boolean }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured")

  const maxLoops = maxIterations || DEFAULT_MAX_TOOL_LOOPS

  // Anthropic tool format
  const claudeTools = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))

  const toolsUsed: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let currentMessages: any[] = [{ role: "user", content: userBody }]

  for (let i = 0; i < maxLoops; i++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS)

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 16384,
        system: systemPrompt,
        tools: claudeTools,
        messages: currentMessages,
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`Claude API error ${res.status}: ${JSON.stringify(err)}`)
    }

    const data = await res.json()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolUseBlocks = data.content.filter((b: any) => b.type === "tool_use")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textBlocks = data.content.filter((b: any) => b.type === "text")

    if (toolUseBlocks.length === 0 || data.stop_reason === "end_turn") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reply = textBlocks.map((b: any) => b.text).join("\n") || ""
      if (reply) return { reply, toolsUsed, reachedMaxLoops: false }
      if (toolUseBlocks.length === 0) {
        return { reply: "(no response generated)", toolsUsed, reachedMaxLoops: false }
      }
    }

    // Execute tools (always through executeWorkerTool — guard).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolResults: any[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const toolBlock of toolUseBlocks) {
      toolsUsed.push(toolBlock.name)
      const result = await executeWorkerTool(toolBlock.name, toolBlock.input || {})
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolBlock.id,
        content: result,
      })
    }

    currentMessages = [
      ...currentMessages,
      { role: "assistant", content: data.content },
      { role: "user", content: toolResults },
    ]
  }

  return {
    reply: `Reached the worker's maximum tool-use iterations (${maxLoops}). Findings may be incomplete — consider narrowing the question.`,
    toolsUsed,
    reachedMaxLoops: true,
  }
}

/**
 * Call sonnet-4-6 with the Hermes-bridge worker subset.
 *
 * Without a threadId this behaves exactly as before: full WORKER_TOOLS + the
 * default WORKER_SYSTEM_PROMPT, no thread bookkeeping.
 *
 * With a threadId (Phase C):
 *   1. resolve the thread's type (read thread_summaries; create it if new),
 *   2. narrow the tool list to that type (getToolsForThreadType),
 *   3. prepend the thread's prior conversation + type-specific formatting guidance,
 *   4. after the reply, resolve the thread with an auto-generated one-paragraph
 *      summary + a derived outcome.
 * Every thread step is best-effort — a thread-layer failure never breaks the
 * core research reply.
 */
export async function callWorker(userBody: string, opts: CallWorkerOptions = {}): Promise<WorkerResponse> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured")

  const threadId = typeof opts.threadId === "string" && opts.threadId.length > 0 ? opts.threadId : null

  let tools: ToolDef[] = WORKER_TOOLS
  let systemPrompt = WORKER_SYSTEM_PROMPT
  let threadType: ThreadType = DEFAULT_THREAD_TYPE
  let rowEnsured = false

  if (threadId) {
    try {
      const existing = await getThreadSummary(threadId)
      threadType = existing ? normalizeThreadType(existing.thread_type) : DEFAULT_THREAD_TYPE
      if (!existing) await createThreadSummary(threadId, threadType, deriveThreadTitle(userBody), WORKER_PROMPT_VERSION)
      rowEnsured = true

      tools = getToolsForThreadType(threadType)
      const ctx = await buildThreadContext(threadId, {
        excludeMessageId: typeof opts.messageId === "string" ? opts.messageId : undefined,
      })
      const addendum = getPromptAddendumForThreadType(threadType)
      systemPrompt = [
        WORKER_SYSTEM_PROMPT,
        addendum ? `\n${addendum}` : "",
        ctx.text
          ? `\nCONVERSATION SO FAR (for reference — the current request follows as the user turn):\n${ctx.text}`
          : "",
      ].join("")
    } catch (err) {
      console.warn(
        `[callWorker] thread setup failed for ${threadId} (falling back to full tool set + default prompt):`,
        err instanceof Error ? err.message : String(err),
      )
      tools = WORKER_TOOLS
      systemPrompt = WORKER_SYSTEM_PROMPT
    }
  }

  const result = await runWorkerLoop(userBody, tools, systemPrompt, opts.maxIterations)

  if (threadId) {
    try {
      if (!rowEnsured) await createThreadSummary(threadId, threadType, deriveThreadTitle(userBody), WORKER_PROMPT_VERSION)
      const proposed = result.toolsUsed.includes("propose_action")
      const outcome = result.reachedMaxLoops
        ? "incomplete"
        : proposed
          ? "action_proposed"
          : "investigation_complete"
      await resolveThread(threadId, outcome, oneParagraphSummary(result.reply))
    } catch (err) {
      console.warn(
        `[callWorker] resolveThread failed for ${threadId} (reply still returned):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return { reply: result.reply, toolsUsed: result.toolsUsed }
}
