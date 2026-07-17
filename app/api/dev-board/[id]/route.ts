/**
 * PATCH /api/dev-board/[id] — dev-tracker board mutations from the UI.
 * Staff-only. Moves:
 *   - { status }                     : direct lane override (a card drag)
 *   - { milestone, note?, postponed? }: advance the lifecycle; the lane is
 *                                       DERIVED (single knob, milestones.ts).
 *   - { refresh_plain: true }        : re-run the AI summarizer on the row as
 *                                       it stands (manual "Refresh summary" —
 *                                       for pre-migration cards or when the AI
 *                                       text is slightly off).
 * Also accepts { channel, priority } small edits. dev_tasks is not a protected
 * table, so a direct update is appropriate here.
 */
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser, getUserDisplayName } from "@/lib/auth"
import { NextRequest, NextResponse } from "next/server"
import {
  advanceMilestone,
  deriveStatusForSet,
  isKeyInSet,
  labelForStage,
  parseMilestones,
} from "@/lib/dev-tracker/milestones"
import { loadStageSetForType } from "@/lib/dev-tracker/load-stage-set"
import { generatePlainFields, progressTail } from "@/lib/dev-tracker/plain-summary"

// The refresh_plain action awaits the AI patch (~16s worst case with model
// failover) — keep the route comfortably above that.
export const maxDuration = 60

// dev_tasks tracker columns are not yet in generated types (prod migrates later).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const VALID_STATUS = ["backlog", "todo", "in_progress", "blocked", "done", "cancelled"]

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  let body: {
    status?: string
    milestone?: string
    note?: string
    postponed?: boolean
    channel?: string
    priority?: string
    knowledge_ref?: string
    knowledge_status?: string
    refresh_plain?: boolean
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // Manual "Refresh summary": re-run the summarizer on the stored record.
  // Separate flow — reads the row, patches only the plain columns, no lane /
  // milestone side effects. Never combined with other edits (the button sends
  // it alone).
  if (body.refresh_plain) {
    const { data: row, error: readErr } = await db
      .from("dev_tasks")
      .select("id, title, type, priority, channel, milestones, description, findings, plan, decisions, blockers, summary_plain, progress_log")
      .eq("id", id)
      .single()
    // Surface the real read error (e.g. missing column pre-migration) instead
    // of a misleading "Job not found".
    if (readErr && readErr.code !== "PGRST116") {
      return NextResponse.json({ error: readErr.message || "Could not load the job" }, { status: 500 })
    }
    if (!row) return NextResponse.json({ error: "Job not found" }, { status: 404 })

    const set = await loadStageSetForType(db, row.type)
    const ms = parseMilestones(row.milestones)
    const ai = await generatePlainFields({
      title: row.title,
      type: row.type,
      priority: row.priority,
      channel: row.channel,
      stageLabel: ms ? labelForStage(set, ms.current) : null,
      description: row.description,
      findings: row.findings,
      plan: row.plan,
      decisions: row.decisions,
      blockers: row.blockers,
      callerSummary: row.summary_plain,
      progressTail: progressTail(row.progress_log),
    })
    if (!ai) {
      return NextResponse.json(
        { error: "The AI summarizer is unavailable right now — the card was left unchanged. Try again in a minute." },
        { status: 503 },
      )
    }
    const { error: patchErr } = await db
      .from("dev_tasks")
      .update({
        summary_plain: ai.summary_plain,
        business_impact: ai.business_impact,
        simple_next_step: ai.simple_next_step,
        plain_generated_at: new Date().toISOString(),
      })
      .eq("id", id)
    if (patchErr) {
      return NextResponse.json({ error: patchErr.message || "Update failed" }, { status: 500 })
    }
    return NextResponse.json({ ok: true, plain: ai })
  }

  const now = new Date().toISOString()
  const by = getUserDisplayName(user) || "Staff"
  const updates: Record<string, unknown> = { updated_at: now }

  // Validate channel against the real channel list (no drift).
  if (body.channel !== undefined) {
    const { data: chans } = await db
      .from("internal_threads")
      .select("channel_slug")
      .eq("thread_type", "channel")
    const valid = (chans || []).map((r: { channel_slug: string }) => r.channel_slug).filter(Boolean)
    if (!valid.includes(body.channel)) {
      return NextResponse.json(
        { error: `Unknown channel "${body.channel}". Valid: ${valid.join(", ") || "(none)"}.` },
        { status: 400 },
      )
    }
    updates.channel = body.channel
  }

  if (body.priority) updates.priority = body.priority

  // Knowledge-capture pointer (where the lasting knowledge was written down).
  if (body.knowledge_status !== undefined) {
    if (body.knowledge_status !== "" && !["captured", "chore"].includes(body.knowledge_status)) {
      return NextResponse.json({ error: `Unknown knowledge_status "${body.knowledge_status}".` }, { status: 400 })
    }
    updates.knowledge_status = body.knowledge_status || null
  }
  if (body.knowledge_ref !== undefined) {
    updates.knowledge_ref = body.knowledge_ref.trim() || null
  }

  // Milestone advance / postpone → derive the lane from the job's stage set.
  let derivedStatus: string | undefined
  if (body.milestone !== undefined || body.postponed !== undefined) {
    const { data: cur } = await db.from("dev_tasks").select("type, milestones").eq("id", id).single()
    if (!cur) return NextResponse.json({ error: "Job not found" }, { status: 404 })
    const set = await loadStageSetForType(db, cur.type)
    const prev = parseMilestones(cur.milestones)
    if (body.milestone !== undefined) {
      if (!isKeyInSet(set, body.milestone)) {
        return NextResponse.json(
          { error: `"${body.milestone}" is not a stage in the ${set.label} lifecycle. Valid: ${set.stages.map((s) => s.key).join(", ")}.` },
          { status: 400 },
        )
      }
      updates.milestones = advanceMilestone(prev, body.milestone, now, by, body.note)
      derivedStatus = deriveStatusForSet(set, body.milestone, { postponed: !!body.postponed })
    } else if (prev) {
      derivedStatus = deriveStatusForSet(set, prev.current, { postponed: !!body.postponed })
    }
  }

  // Explicit status (a drag) wins over the derived lane.
  const finalStatus = body.status ?? derivedStatus
  if (finalStatus) {
    if (!VALID_STATUS.includes(finalStatus)) {
      return NextResponse.json({ error: `Unknown status "${finalStatus}".` }, { status: 400 })
    }
    updates.status = finalStatus
    if (finalStatus === "in_progress") updates.started_at = now
    if (finalStatus === "done") updates.completed_at = now
  }

  const { data, error } = await db
    .from("dev_tasks")
    .update(updates)
    .eq("id", id)
    .select("id, title, status, channel, milestones, priority, updated_at")
    .single()

  if (error) {
    return NextResponse.json({ error: error.message || "Update failed" }, { status: 500 })
  }
  return NextResponse.json({ ok: true, job: data })
}
