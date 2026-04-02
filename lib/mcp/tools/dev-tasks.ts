/**
 * Dev Task MCP Tools
 *
 * CRUD for the dev_tasks table — used by Antonio Brain to create,
 * list, and update development tasks that Claude Code picks up.
 *
 * Table: dev_tasks (Supabase)
 * Enums:
 *   dev_task_type:     feature | bugfix | refactor | cleanup | docs | infra
 *   dev_task_status:   backlog | todo | in_progress | blocked | done | cancelled
 *   dev_task_priority: critical | high | medium | low
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

export function registerDevTaskTools(server: McpServer) {

  // ─── dev_task_create ─────────────────────────────────────
  server.tool(
    "dev_task_create",
    "Create a new development task for Claude Code. Use when Antonio requests a feature, reports a bug, or needs a code change. Tasks are picked up by Claude Code via dev_task_list.",
    {
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("Detailed description of the task"),
      type: z.enum(["feature", "bugfix", "refactor", "cleanup", "docs", "infra"])
        .default("feature").describe("Task type (default: feature)"),
      priority: z.enum(["critical", "high", "medium", "low"])
        .default("high").describe("Task priority (default: high)"),
    },
    async ({ title, description, type, priority }) => {
      try {
        // Check for duplicate before inserting
        const { data: existing } = await supabaseAdmin
          .from("dev_tasks")
          .select("id, title, status")
          .ilike("title", `%${title}%`)
          .in("status", ["backlog", "todo", "in_progress"])
          .limit(1)

        if (existing && existing.length > 0) {
          return {
            content: [{
              type: "text" as const,
              text: `⚠️ Similar task already exists:\n• ${existing[0].title} (${existing[0].status})\n  ID: ${existing[0].id}\n\nUse dev_task_update to modify it instead.`,
            }],
          }
        }

        const { data, error } = await supabaseAdmin
          .from("dev_tasks")
          .insert({
            title,
            description: description || null,
            type,
            priority,
            status: "todo",
          })
          .select("id, title, type, priority, status, created_at")
          .single()

        if (error) throw error

        return {
          content: [{
            type: "text" as const,
            text: `✅ Dev task created\n• Title: ${data.title}\n• Type: ${data.type} | Priority: ${data.priority} | Status: ${data.status}\n• ID: ${data.id}`,
          }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `❌ Error: ${message}` }],
        }
      }
    }
  )

  // ─── dev_task_list ───────────────────────────────────────
  server.tool(
    "dev_task_list",
    "List dev tasks by status. Default returns all non-cancelled tasks ordered by priority. Use to see what's pending or in progress.",
    {
      status: z.enum(["backlog", "todo", "in_progress", "blocked", "done", "cancelled"])
        .optional().describe("Filter by status. Omit to show all non-cancelled."),
      limit: z.number().default(10).describe("Max results (default 10)"),
    },
    async ({ status, limit }) => {
      try {
        let query = supabaseAdmin
          .from("dev_tasks")
          .select("id, title, type, status, priority, created_at, updated_at, blockers, progress_log, decisions, related_files")

        if (status) {
          query = query.eq("status", status)
        } else {
          query = query.neq("status", "cancelled")
        }

        const { data, error } = await query
          .order("priority", { ascending: true }) // critical=first via enum order
          .order("created_at", { ascending: false })
          .limit(limit)

        if (error) throw error

        if (!data || data.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: status ? `No dev tasks with status '${status}'.` : "No open dev tasks.",
            }],
          }
        }

        const priorityIcon: Record<string, string> = {
          critical: "🔴",
          high: "🟠",
          medium: "🟡",
          low: "⚪",
        }

        const lines = data.map((t) => {
          const icon = priorityIcon[t.priority] || "⚪"
          let line = `${icon} **${t.title}** [${t.status}] (${t.type})\n   ID: ${t.id}`
          if (t.blockers) line += `\n   ⛔ Blockers: ${t.blockers}`
          if (t.progress_log) {
            // Show last progress entry
            try {
              const log = JSON.parse(t.progress_log)
              if (Array.isArray(log) && log.length > 0) {
                const last = log[log.length - 1]
                line += `\n   📝 Last: ${last.action} → ${last.result}`
              }
            } catch {
              // progress_log might not be valid JSON
            }
          }
          return line
        })

        return {
          content: [{
            type: "text" as const,
            text: `📋 Dev Tasks (${data.length}):\n\n${lines.join("\n\n")}`,
          }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `❌ Error: ${message}` }],
        }
      }
    }
  )

  // ─── dev_task_update ─────────────────────────────────────
  server.tool(
    "dev_task_update",
    "Update a dev task. Change status, log blockers, record decisions. Use progress_entry to append a log entry without overwriting history.",
    {
      id: z.string().uuid().describe("Dev task UUID"),
      status: z.enum(["backlog", "todo", "in_progress", "blocked", "done", "cancelled"])
        .optional().describe("New status"),
      blockers: z.string().optional().describe("Current blockers (replaces existing)"),
      decisions: z.string().optional().describe("Key decisions made (replaces existing)"),
      progress_entry: z.object({
        action: z.string().describe("What was done"),
        result: z.string().describe("Outcome"),
      }).optional().describe("Append a progress log entry without overwriting history"),
      title: z.string().optional().describe("Updated title"),
      description: z.string().optional().describe("Updated description"),
      priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("New priority"),
      related_files: z.array(z.string()).optional().describe("Related file paths"),
    },
    async ({ id, status, blockers, decisions, progress_entry, title, description, priority, related_files }) => {
      try {
        // Build updates object
        const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

        if (status) {
          updates.status = status
          if (status === "in_progress" && !updates.started_at) {
            updates.started_at = new Date().toISOString()
          }
          if (status === "done") {
            updates.completed_at = new Date().toISOString()
          }
        }
        if (blockers !== undefined) updates.blockers = blockers
        if (decisions !== undefined) updates.decisions = decisions
        if (title) updates.title = title
        if (description) updates.description = description
        if (priority) updates.priority = priority
        if (related_files) updates.related_files = related_files

        // Handle progress_entry — fetch current log, append
        if (progress_entry) {
          const { data: current } = await supabaseAdmin
            .from("dev_tasks")
            .select("progress_log")
            .eq("id", id)
            .single()

          let log: Array<{ date: string; action: string; result: string }> = []
          if (current?.progress_log) {
            try {
              log = JSON.parse(current.progress_log)
              if (!Array.isArray(log)) log = []
            } catch {
              log = []
            }
          }

          log.push({
            date: new Date().toISOString().split("T")[0],
            action: progress_entry.action,
            result: progress_entry.result,
          })

          updates.progress_log = JSON.stringify(log)
        }

        const { data, error } = await supabaseAdmin
          .from("dev_tasks")
          .update(updates)
          .eq("id", id)
          .select("id, title, status, priority, updated_at")
          .single()

        if (error) throw error

        return {
          content: [{
            type: "text" as const,
            text: `✅ Task updated: ${data.title}\n• Status: ${data.status} | Priority: ${data.priority}\n• ID: ${data.id}`,
          }],
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: "text" as const, text: `❌ Error: ${message}` }],
        }
      }
    }
  )
}
