/**
 * Session Checkpoint Tool
 *
 * One-call save for Claude.ai sessions. Saves summary + next steps
 * to session_checkpoints table and resets the tool call counter.
 *
 * This replaces the need for complex SQL to save progress.
 * The reminder middleware (reminder.ts) nudges the agent to call this.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

export function registerCheckpointTools(server: McpServer) {

  server.tool(
    "session_checkpoint",
    "Save session progress in one call. Use this to checkpoint your work — saves a summary of what was done and what's pending. Resets the tool call counter. Call this every 5-10 tool calls, or after any significant action (CRM change, document processed, decision made). This is your PRIMARY way to prevent data loss from context compaction.",
    {
      summary: z.string().describe("Brief summary of what was accomplished (e.g. 'Created AG Group LLC account, processed 5 documents, updated EIN')"),
      next_steps: z.string().optional().describe("What needs to happen next (e.g. 'File EIN application, send onboarding email')"),
      session_type: z.enum(["dev", "ops"]).default("ops").describe("'dev' for development work, 'ops' for operational/client work"),
    },
    async ({ summary, next_steps, session_type }) => {
      try {
        // Get current call count before resetting
        const { data: counterData } = await supabaseAdmin
          .from("mcp_tool_counter")
          .select("calls_since_checkpoint")
          .eq("id", 1)
          .single()

        const callCount = counterData?.calls_since_checkpoint ?? 0

        // Save checkpoint
        const { data: checkpoint, error: saveError } = await supabaseAdmin
          .from("session_checkpoints")
          .insert({
            summary,
            next_steps: next_steps || null,
            session_type,
            tool_calls_at_save: callCount,
          })
          .select("id, created_at")
          .single()

        if (saveError) {
          return {
            content: [{
              type: "text" as const,
              text: `❌ Failed to save checkpoint: ${saveError.message}`,
            }],
          }
        }

        // Reset counter
        await supabaseAdmin.rpc("reset_tool_counter")

        const ts = new Date(checkpoint.created_at).toLocaleString("it-IT", {
          timeZone: "Europe/Rome",
          hour: "2-digit",
          minute: "2-digit",
        })

        return {
          content: [{
            type: "text" as const,
            text: `✅ Checkpoint saved (${ts}, ${callCount} tool calls)\n📝 ${summary}${next_steps ? `\n⏭️ Next: ${next_steps}` : ""}`,
          }],
        }
      } catch (err: any) {
        return {
          content: [{
            type: "text" as const,
            text: `❌ Checkpoint failed: ${err.message}`,
          }],
        }
      }
    }
  )
}
