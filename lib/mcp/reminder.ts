/**
 * MCP Reminder Middleware
 *
 * Wraps server.tool() so that every tool response automatically
 * includes a checkpoint reminder after N calls without saving.
 *
 * This is the Claude.ai equivalent of the PreCompact hook on Claude Code.
 * Since Claude.ai has no hooks, we inject reminders directly into
 * tool responses — the agent cannot ignore them.
 *
 * Overhead: ~50ms per tool call (one atomic DB query).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { supabaseAdmin } from "@/lib/supabase-admin"

const SOFT_THRESHOLD = 5   // gentle reminder
const HARD_THRESHOLD = 10  // strong reminder
const URGENT_THRESHOLD = 15 // urgent reminder

// Tools that should NOT trigger the counter (read-only / meta)
const SKIP_TOOLS = new Set([
  "session_checkpoint",
])

export function addReminderMiddleware(server: McpServer) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originalTool = (server as any).tool.bind(server)

  // Monkey-patch server.tool to wrap every handler
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(server as any).tool = function (...args: any[]) {
    // Handler is always the last argument
    const lastIdx = args.length - 1
    const originalHandler = args[lastIdx]

    if (typeof originalHandler !== "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalTool as any)(...args)
    }

    const toolName: string = args[0]

    // Replace handler with wrapped version
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args[lastIdx] = async function (...handlerArgs: any[]) {
      // Call original handler first — tool must always work
      const result = await originalHandler.apply(null, handlerArgs)

      // Skip counter for meta tools
      if (SKIP_TOOLS.has(toolName)) return result

      // Increment counter and maybe append reminder
      try {
        const { data } = await supabaseAdmin.rpc("increment_tool_counter")

        if (data && typeof data === "object") {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const callsSince = (data as any).calls_since ?? 0

          let reminder: string | null = null

          if (callsSince >= URGENT_THRESHOLD) {
            reminder = `🔴 URGENT: ${callsSince} tool calls without checkpoint! You MUST save now. Call session_checkpoint with a summary of what you've done and what's pending. Do this BEFORE your next action.`
          } else if (callsSince >= HARD_THRESHOLD) {
            reminder = `🟠 WARNING: ${callsSince} tool calls since last checkpoint. Save your progress now with session_checkpoint({summary: "what you did", next_steps: "what's pending"}).`
          } else if (callsSince >= SOFT_THRESHOLD) {
            reminder = `🟡 Reminder: ${callsSince} tool calls since last checkpoint. Consider saving with session_checkpoint.`
          }

          if (reminder && result?.content && Array.isArray(result.content)) {
            result.content.push({
              type: "text" as const,
              text: `\n\n---\n${reminder}`,
            })
          }
        }
      } catch {
        // Never let reminder logic break tool functionality
      }

      return result
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalTool as any)(...args)
  }
}
