/**
 * Dev Task MCP Tools
 *
 * CRUD for the dev_tasks table — the single source of truth for dev work and
 * the backing store for the per-channel dev-tracker board (Team Chat).
 *
 * Table: dev_tasks (Supabase)
 * Enums:
 *   dev_task_type:     feature | bugfix | refactor | cleanup | docs | infra
 *   dev_task_status:   backlog | todo | in_progress | blocked | done | cancelled
 *   dev_task_priority: critical | high | medium | low
 * Tracker fields: channel, findings, plan, summary_plain, milestones.
 * Stages come from a StageSet chosen by the job's type (stage-sets.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  DEFAULT_STAGE_SET,
  advanceMilestone,
  deriveStatusForSet,
  initialMilestones,
  isKeyInSet,
  labelForStage,
  parseMilestones,
} from "@/lib/dev-tracker/milestones"
import { loadStageSetForType } from "@/lib/dev-tracker/load-stage-set"

const TRACKER_AUTHOR = "Claude"

// dev_tasks carries tracker columns not yet in the generated types (prod
// migrates later). Alias past the typed query builder.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

/** Validate a channel slug against the REAL channel list (no drift). */
async function validateChannel(slug: string): Promise<{ ok: boolean; valid: string[] }> {
  const { data } = await db
    .from("internal_threads")
    .select("channel_slug")
    .eq("thread_type", "channel")
  const valid = (data || []).map((r: { channel_slug: string }) => r.channel_slug).filter(Boolean)
  return { ok: valid.includes(slug), valid }
}

export function registerDevTaskTools(server: McpServer) {

  // ─── dev_task_create ─────────────────────────────────────
  server.tool(
    "dev_task_create",
    "Create a development job on the dev-tracker board. Use when Antonio requests a feature, reports a bug, or a new bug/task surfaces mid-session. `channel` files it (td-dev|td-bug|td-support…); `parent_id` links it as a child spun off from another job. The job starts at the first stage of its type's lifecycle. Jobs are the durable, compaction-proof record every session reads and continues.",
    {
      title: z.string().describe("Task title"),
      description: z.string().optional().describe("TECHNICAL request/detail for the coding session (verbatim where possible)"),
      summary_plain: z.string().optional().describe("PLAIN-ENGLISH one/two-line summary for Antonio — what this is and where it stands, no jargon. Shown at the top of the card."),
      type: z.enum(["feature", "bugfix", "refactor", "cleanup", "docs", "infra"])
        .default("feature").describe("Task type (default: feature). Determines the stage lifecycle."),
      priority: z.enum(["critical", "high", "medium", "low"])
        .default("high").describe("Task priority (default: high)"),
      channel: z.string().optional()
        .describe("Board channel slug (td-dev|td-bug|td-support…). Validated against the real channel list."),
      parent_id: z.string().uuid().optional()
        .describe("Parent job UUID — set when this is a child bug/task spun off from another job."),
    },
    async ({ title, description, summary_plain, type, priority, channel, parent_id }) => {
      try {
        if (channel) {
          const v = await validateChannel(channel)
          if (!v.ok) {
            return { content: [{ type: "text" as const, text: `❌ Unknown channel "${channel}". Valid channels: ${v.valid.join(", ") || "(none)"}.` }] }
          }
        }

        if (!parent_id) {
          const { data: existing } = await db
            .from("dev_tasks")
            .select("id, title, status")
            .ilike("title", `%${title}%`)
            .in("status", ["backlog", "todo", "in_progress"])
            .limit(1)
          if (existing && existing.length > 0) {
            return { content: [{ type: "text" as const, text: `⚠️ Similar task already exists:\n• ${existing[0].title} (${existing[0].status})\n  ID: ${existing[0].id}\n\nUse dev_task_update to modify it instead.` }] }
          }
        }

        const now = new Date().toISOString()
        const set = await loadStageSetForType(db, type)
        const startStage = set.stages[0]?.key || "requested"

        const { data, error } = await db
          .from("dev_tasks")
          .insert({
            title,
            description: description || null,
            summary_plain: summary_plain || null,
            type,
            priority,
            status: deriveStatusForSet(set, startStage),
            channel: channel || null,
            parent_task_id: parent_id || null,
            milestones: initialMilestones(now, TRACKER_AUTHOR, startStage),
          })
          .select("id, title, type, priority, status, channel")
          .single()

        if (error) throw error

        return {
          content: [{
            type: "text" as const,
            text: `✅ Dev job created\n• Title: ${data.title}\n• Type: ${data.type} | Priority: ${data.priority} | Channel: ${data.channel || "—"}${parent_id ? " | child of " + parent_id : ""}\n• Lifecycle: ${set.label} | Stage: ${labelForStage(set, startStage)} | Lane: ${data.status}\n• ID: ${data.id}`,
          }],
        }
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ─── dev_task_list ───────────────────────────────────────
  server.tool(
    "dev_task_list",
    "List dev jobs. Filter by status and/or channel. Default returns all non-cancelled jobs ordered by priority. Shows each job's channel, current milestone, and last progress entry — read this at session start to find the open job and continue it (don't create a duplicate).",
    {
      status: z.enum(["backlog", "todo", "in_progress", "blocked", "done", "cancelled"])
        .optional().describe("Filter by status. Omit to show all non-cancelled."),
      channel: z.string().optional().describe("Filter by board channel slug (td-dev|td-bug|td-support…)."),
      limit: z.number().default(10).describe("Max results (default 10)"),
    },
    async ({ status, channel, limit }) => {
      try {
        let query = db
          .from("dev_tasks")
          .select("id, title, type, status, priority, channel, milestones, created_at, updated_at, blockers, progress_log, decisions, related_files, parent_task_id")

        if (status) query = query.eq("status", status)
        else query = query.neq("status", "cancelled")
        if (channel) query = query.eq("channel", channel)

        const { data, error } = await query
          .order("priority", { ascending: true })
          .order("created_at", { ascending: false })
          .limit(limit)

        if (error) throw error
        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: status ? `No dev jobs with status '${status}'.` : "No open dev jobs." }] }
        }

        const priorityIcon: Record<string, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪" }
        const lines = data.map((t: Record<string, unknown>) => {
          const icon = priorityIcon[t.priority as string] || "⚪"
          const ms = parseMilestones(t.milestones)
          const stageLabel = ms ? labelForStage(DEFAULT_STAGE_SET, ms.current) : "—"
          let line = `${icon} **${t.title}** [${t.status}] (${t.type})\n   Channel: ${t.channel || "—"} | Milestone: ${stageLabel}\n   ID: ${t.id}`
          if (t.parent_task_id) line += `\n   ↳ child of ${t.parent_task_id}`
          if (t.blockers) line += `\n   ⛔ Blockers: ${t.blockers}`
          if (t.progress_log) {
            try {
              const log = JSON.parse(t.progress_log as string)
              if (Array.isArray(log) && log.length > 0) {
                const last = log[log.length - 1]
                line += `\n   📝 Last: ${last.action} → ${last.result}`
              }
            } catch { /* not JSON */ }
          }
          return line
        })

        return { content: [{ type: "text" as const, text: `📋 Dev Jobs (${data.length}):\n\n${lines.join("\n\n")}` }] }
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )

  // ─── dev_task_update ─────────────────────────────────────
  server.tool(
    "dev_task_update",
    "Update a dev job as work progresses. Record findings (audit), freeze the approved plan, append a progress entry (optionally tagged to the stage it belongs to), log decisions/blockers, move the channel. Use `milestone` to advance the lifecycle (forward OR backward — a QA fail goes back); the board lane is derived automatically. An explicit `status` still wins when you need it (e.g. cancelled). Valid milestone keys depend on the job's type lifecycle.",
    {
      id: z.string().uuid().describe("Dev job UUID"),
      milestone: z.string().optional().describe("Advance the lifecycle to this stage KEY (must belong to the job's lifecycle; non-linear — can go backward). Lane is derived from it."),
      milestone_note: z.string().optional().describe("Optional note recorded with the milestone move (a waypoint in the trail)."),
      postponed: z.boolean().optional().describe("Park the job (lane → Postponed) without losing its milestone. false clears it."),
      status: z.enum(["backlog", "todo", "in_progress", "blocked", "done", "cancelled"])
        .optional().describe("Explicit lane override (wins over derived). Use for blocked/cancelled."),
      channel: z.string().optional().describe("Move the job to this board channel (validated)."),
      summary_plain: z.string().optional().describe("PLAIN-ENGLISH summary for Antonio (replaces existing). Update it whenever you change the technical detail so the two never drift."),
      findings: z.string().optional().describe("Audit/investigation findings (replaces existing)."),
      plan: z.string().optional().describe("The approved plan, frozen (replaces existing)."),
      blockers: z.string().optional().describe("Current blockers (replaces existing)"),
      decisions: z.string().optional().describe("Key decisions made (replaces existing)"),
      progress_entry: z.object({
        action: z.string().describe("What was done"),
        result: z.string().describe("Outcome"),
        stage: z.string().optional().describe("Stage this waypoint belongs to (defaults to the current stage)."),
      }).optional().describe("Append a progress log entry (a trail waypoint) without overwriting history"),
      title: z.string().optional().describe("Updated title"),
      description: z.string().optional().describe("Updated description (the original request)"),
      priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("New priority"),
      related_files: z.array(z.string()).optional().describe("Related file paths"),
      knowledge_ref: z.string().optional().describe("WHERE this job's lasting knowledge was written down — a living system doc (e.g. 'docs/systems/dev-tracker.md'), a KB article id, or a sysdoc slug. The board points to the doc, it never copies it (docs/KB stay the single source of truth). Set this when finishing a job so closing the card never loses what it taught."),
      knowledge_status: z.enum(["captured", "chore"]).optional().describe("'captured' = a pointer is recorded in knowledge_ref; 'chore' = pure mechanical work, nothing worth documenting. Set one when moving a job to done."),
    },
    async ({ id, milestone, milestone_note, postponed, status, channel, summary_plain, findings, plan, blockers, decisions, progress_entry, title, description, priority, related_files, knowledge_ref, knowledge_status }) => {
      try {
        const now = new Date().toISOString()

        const { data: job } = await db.from("dev_tasks").select("type, milestones, progress_log, knowledge_status").eq("id", id).single()
        if (!job) return { content: [{ type: "text" as const, text: `❌ Job ${id} not found.` }] }
        const set = await loadStageSetForType(db, job.type)
        const prevMs = parseMilestones(job.milestones)

        const updates: Record<string, unknown> = { updated_at: now }

        if (channel !== undefined) {
          const v = await validateChannel(channel)
          if (!v.ok) return { content: [{ type: "text" as const, text: `❌ Unknown channel "${channel}". Valid channels: ${v.valid.join(", ") || "(none)"}.` }] }
          updates.channel = channel
        }
        if (summary_plain !== undefined) updates.summary_plain = summary_plain
        if (findings !== undefined) updates.findings = findings
        if (plan !== undefined) updates.plan = plan
        if (blockers !== undefined) updates.blockers = blockers
        if (decisions !== undefined) updates.decisions = decisions
        if (title) updates.title = title
        if (description) updates.description = description
        if (priority) updates.priority = priority
        if (related_files) updates.related_files = related_files
        if (knowledge_ref !== undefined) updates.knowledge_ref = knowledge_ref.trim() || null
        if (knowledge_status !== undefined) updates.knowledge_status = knowledge_status

        // Milestone advance → derive the lane from the job's stage set.
        let derivedStatus: string | undefined
        if (milestone) {
          if (!isKeyInSet(set, milestone)) {
            return { content: [{ type: "text" as const, text: `❌ "${milestone}" is not a stage in the ${set.label} lifecycle. Valid stages: ${set.stages.map((s) => s.key).join(", ")}.` }] }
          }
          updates.milestones = advanceMilestone(prevMs, milestone, now, TRACKER_AUTHOR, milestone_note)
          derivedStatus = deriveStatusForSet(set, milestone, { postponed: !!postponed })
        } else if (postponed !== undefined && prevMs) {
          derivedStatus = deriveStatusForSet(set, prevMs.current, { postponed: !!postponed })
        }

        const finalStatus = status ?? derivedStatus
        if (finalStatus) {
          updates.status = finalStatus
          if (finalStatus === "in_progress") updates.started_at = now
          if (finalStatus === "done") updates.completed_at = now
        }

        // Progress entry — tagged to the stage it belongs to.
        if (progress_entry) {
          let log: Array<Record<string, unknown>> = []
          if (job.progress_log) {
            try { const p = JSON.parse(job.progress_log); if (Array.isArray(p)) log = p } catch { /* reset */ }
          }
          const entryStage = progress_entry.stage || milestone || prevMs?.current || set.stages[0]?.key
          log.push({ date: now.split("T")[0], action: progress_entry.action, result: progress_entry.result, stage: entryStage })
          updates.progress_log = JSON.stringify(log)
        }

        const { data, error } = await db
          .from("dev_tasks")
          .update(updates)
          .eq("id", id)
          .select("id, title, status, priority, channel, milestones")
          .single()

        if (error) throw error
        const ms = parseMilestones(data.milestones)
        const stageLabel = ms ? labelForStage(set, ms.current) : "—"

        // Soft nudge: a job closed without recording where its knowledge went.
        const knownAfter = knowledge_status ?? job.knowledge_status
        const nudge =
          finalStatus === "done" && !knownAfter
            ? "\n\n📎 Before this folds away: record where its lasting knowledge went — pass `knowledge_ref` (a living doc / KB id / sysdoc slug) or set `knowledge_status:\"chore\"` if there's nothing to document."
            : ""

        return {
          content: [{
            type: "text" as const,
            text: `✅ Job updated: ${data.title}\n• Lane: ${data.status} | Milestone: ${stageLabel} | Channel: ${data.channel || "—"} | Priority: ${data.priority}\n• ID: ${data.id}${nudge}`,
          }],
        }
      } catch (err: unknown) {
        return { content: [{ type: "text" as const, text: `❌ Error: ${err instanceof Error ? err.message : String(err)}` }] }
      }
    }
  )
}
