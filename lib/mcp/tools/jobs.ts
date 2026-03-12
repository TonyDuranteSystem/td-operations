/**
 * Job Queue MCP Tools — check status and list background jobs.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"

export function registerJobTools(server: McpServer) {

  // ═══════════════════════════════════════
  // job_status
  // ═══════════════════════════════════════
  server.tool(
    "job_status",
    "Check the status of a background job by ID. Returns job type, status, step-by-step results, error info, and timing. Use this after enqueuing a job (e.g., from onboarding_form_review) to check if it completed successfully.",
    {
      job_id: z.string().uuid().describe("Job UUID (returned when job was enqueued)"),
    },
    async ({ job_id }) => {
      try {
        const { data: job, error } = await supabaseAdmin
          .from("job_queue")
          .select("*")
          .eq("id", job_id)
          .single()

        if (error || !job) {
          return { content: [{ type: "text" as const, text: `Job not found: ${job_id}` }] }
        }

        const result = job.result as { steps?: Array<{ name: string; status: string; detail?: string; timestamp?: string }>; summary?: string } | null
        const lines: string[] = []

        // Status emoji
        const statusEmoji: Record<string, string> = {
          pending: "⏳",
          processing: "🔄",
          completed: "✅",
          failed: "❌",
          cancelled: "🚫",
        }

        lines.push(`${statusEmoji[job.status] || "?"} Job: ${job.id}`)
        lines.push(`   Type: ${job.job_type}`)
        lines.push(`   Status: ${job.status}`)
        lines.push(`   Attempts: ${job.attempts}/${job.max_attempts}`)
        lines.push(`   Created: ${job.created_at}`)
        if (job.started_at) lines.push(`   Started: ${job.started_at}`)
        if (job.completed_at) lines.push(`   Completed: ${job.completed_at}`)
        if (job.account_id) lines.push(`   Account: ${job.account_id}`)
        if (job.error) lines.push(`   Error: ${job.error}`)

        if (result?.steps && result.steps.length > 0) {
          lines.push("")
          lines.push("Steps:")
          for (const s of result.steps) {
            const icon = s.status === "ok" ? "✅" : s.status === "error" ? "❌" : "⏭️"
            lines.push(`   ${icon} ${s.name}${s.detail ? ` — ${s.detail}` : ""}`)
          }
        }

        if (result?.summary) {
          lines.push("")
          lines.push(`Summary: ${result.summary}`)
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] }
      }
    }
  )

  // ═══════════════════════════════════════
  // job_list
  // ═══════════════════════════════════════
  server.tool(
    "job_list",
    "List recent background jobs with optional filters. Shows job ID, type, status, account, and timing. Use job_status with a specific job ID for full step-by-step details.",
    {
      status: z.enum(["pending", "processing", "completed", "failed", "cancelled"]).optional()
        .describe("Filter by status"),
      job_type: z.string().optional().describe("Filter by job type (e.g., 'onboarding_setup')"),
      account_id: z.string().uuid().optional().describe("Filter by account UUID"),
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
    },
    async ({ status, job_type, account_id, limit }) => {
      try {
        let q = supabaseAdmin
          .from("job_queue")
          .select("id, job_type, status, priority, attempts, max_attempts, error, created_at, started_at, completed_at, account_id, related_entity_type")
          .order("created_at", { ascending: false })
          .limit(limit || 20)

        if (status) q = q.eq("status", status)
        if (job_type) q = q.eq("job_type", job_type)
        if (account_id) q = q.eq("account_id", account_id)

        const { data: jobs, error } = await q
        if (error) throw new Error(error.message)
        if (!jobs || jobs.length === 0) {
          return { content: [{ type: "text" as const, text: "No jobs found." }] }
        }

        const statusEmoji: Record<string, string> = {
          pending: "⏳",
          processing: "🔄",
          completed: "✅",
          failed: "❌",
          cancelled: "🚫",
        }

        const lines = [`📋 ${jobs.length} job(s):`, ""]
        for (const j of jobs) {
          const emoji = statusEmoji[j.status] || "?"
          const elapsed = j.completed_at && j.started_at
            ? `${Math.round((new Date(j.completed_at).getTime() - new Date(j.started_at).getTime()) / 1000)}s`
            : ""
          lines.push(`${emoji} ${j.id.slice(0, 8)}… | ${j.job_type} | ${j.status} | ${j.attempts}/${j.max_attempts}${elapsed ? ` | ${elapsed}` : ""}${j.error ? ` | err: ${j.error.slice(0, 50)}` : ""}`)
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }] }
      }
    }
  )
}
