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

import { AGENT_TOOLS, executeTool, type ToolDef } from "./tools"

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
 * Tools handed to sonnet at request time.
 */
export const WORKER_TOOLS: ToolDef[] = AGENT_TOOLS.filter((t) => WORKER_READ_ONLY_TOOL_NAMES.has(t.name))

/**
 * Wrapped execute that hard-rejects any tool name not in the allow-list.
 * Defense-in-depth: even if sonnet somehow names a tool outside its visible
 * list, this returns a clear error instead of delegating to executeTool.
 */
export async function executeWorkerTool(name: string, params: Record<string, unknown>): Promise<string> {
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
  "  1. Investigate using the read-only tools available to you (CRM search/get, Gmail read, Drive list, KB/SOP search).",
  "  2. Verify every factual claim against a fresh tool call. NEVER assume column names, schemas, client state, or past actions.",
  "  3. Reply with concise, plain-English findings suitable for Hermes to relay back to Antonio on Telegram.",
  "  4. If an action is implied (send an email, update a record, push code), DESCRIBE the action you would propose — DO NOT call any tool that would execute it. You have no write/send/mutate tools. Action execution requires Antonio's explicit approval via the Phase 2 approval rail (not yet built).",
  "",
  "Output discipline:",
  "  - Plain English, no internal jargon.",
  "  - Show citations to file paths, table+column names, or doc slugs when the finding depends on them.",
  "  - Separate verified facts from inference. Flag anything you couldn't verify.",
  "  - Keep it short enough for a Telegram chat — Hermes will summarize further if needed.",
].join("\n")

// ─────────────────────────────────────────────────────────────────────────────
// callWorker — Claude (sonnet-4-6) tool-use loop, scoped to WORKER_TOOLS
// ─────────────────────────────────────────────────────────────────────────────

interface WorkerResponse {
  reply: string
  toolsUsed: string[]
}

const MAX_TOOL_LOOPS = 8
const ANTHROPIC_TIMEOUT_MS = 55_000 // per-call ceiling; cron route's maxDuration=300 covers the whole loop

/**
 * Call sonnet-4-6 with the Hermes-bridge worker subset.
 *
 * Mirrors callClaude() in lib/ai-agent/providers.ts but:
 *   - Tools come from WORKER_TOOLS (not the full AGENT_TOOLS).
 *   - System prompt is WORKER_SYSTEM_PROMPT (not the dashboard's SYSTEM_PROMPT).
 *   - executeWorkerTool() is used for tool dispatch (extra guard).
 */
export async function callWorker(userBody: string): Promise<WorkerResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured")

  // Anthropic tool format
  const claudeTools = WORKER_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))

  const toolsUsed: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let currentMessages: any[] = [{ role: "user", content: userBody }]

  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
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
        max_tokens: 2048,
        system: WORKER_SYSTEM_PROMPT,
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
      if (reply) return { reply, toolsUsed }
      if (toolUseBlocks.length === 0) {
        return { reply: "(no response generated)", toolsUsed }
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
    reply: "Reached the worker's maximum tool-use iterations (8). Findings may be incomplete — consider narrowing the question.",
    toolsUsed,
  }
}
