import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser, getUserDisplayName } from "@/lib/auth"
import { decideCodeTaskAction, type CodeTaskAction } from "@/lib/code-tasks/actions"
import { NextResponse } from "next/server"

/**
 * POST /api/code-tasks/[id]/action   body: { action: 'promote'|'retry'|'cancel'|'dismiss' }
 *
 * CRM controls for a Slack code task (agent_messages row, recipient='code_runner').
 * Admin-only. The decision is computed by the pure decideCodeTaskAction() helper
 * (unit-tested); this route just performs the mapped mutation:
 *  - queue_promote → insert a NEW code_runner row with context_json.promote_branch
 *    (identical to the Slack "ship it" path) → the runner promotes the branch to prod.
 *  - requeue       → flip the SAME row back to 'pending' (runner re-claims it).
 *  - mark_cancelled→ flip a not-yet-claimed 'pending' row to 'cancelled'.
 *  - mark_dismissed→ cosmetic: context_json.dismissed=true (hidden from the list).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const action = body.action as CodeTaskAction
  if (!["promote", "retry", "cancel", "dismiss"].includes(action)) {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as any
  const { data: task } = await sb
    .from("agent_messages")
    .select("id, status, context_json")
    .eq("id", id)
    .eq("recipient", "code_runner")
    .maybeSingle()
  if (!task) return NextResponse.json({ error: "Code task not found" }, { status: 404 })

  const ctx = task.context_json || {}
  const decision = decideCodeTaskAction(
    { status: task.status, code_branch: ctx.code_branch ?? null, is_promote: !!ctx.promote_branch },
    action,
  )
  if (!decision.ok) {
    // Narrow via the presence of `error` (robust discriminant for the failure variant).
    const fail = decision as Extract<typeof decision, { ok: false }>
    return NextResponse.json({ error: fail.error }, { status: fail.code })
  }

  const actor = getUserDisplayName(user)
  const nowIso = new Date().toISOString()
  const ok = decision as Extract<typeof decision, { ok: true }>

  try {
    if (ok.kind === "queue_promote") {
      // Mirror the Slack "ship it" path: a fresh code_runner row carrying the
      // branch to promote. The runner's promoteBranchToMain merges it into main
      // (full build/test gate) — the ONLY place it deploys to production.
      const { data: inserted, error } = await sb
        .from("agent_messages")
        .insert({
          sender: "claude",
          recipient: "code_runner",
          subject: ("Ship " + ok.branch).slice(0, 200),
          body: `Promote review branch ${ok.branch} to production (approved from CRM by ${actor}).`,
          status: "pending",
          context_json: {
            title: `Ship ${ok.branch}`,
            source: "crm_promote",
            promote_branch: ok.branch,
            approved_by: actor,
            origin_task_id: id,
          },
        })
        .select("id")
        .single()
      if (error) throw error
      return NextResponse.json({ ok: true, action: "promote", promote_task_id: inserted?.id })
    }

    if (ok.kind === "requeue") {
      const { error } = await sb
        .from("agent_messages")
        .update({ status: "pending", claimed_at: null, claimed_by: null, error_text: null, updated_at: nowIso })
        .eq("id", id)
        .eq("recipient", "code_runner")
      if (error) throw error
      return NextResponse.json({ ok: true, action: "retry" })
    }

    if (ok.kind === "mark_cancelled") {
      // Guard on status='pending' (TOCTOU) so we never cancel a row the runner
      // just claimed between our read and write.
      const { data: updated, error } = await sb
        .from("agent_messages")
        .update({ status: "cancelled", updated_at: nowIso })
        .eq("id", id)
        .eq("recipient", "code_runner")
        .eq("status", "pending")
        .select("id")
      if (error) throw error
      if (!updated || updated.length === 0) {
        return NextResponse.json({ error: "Task was just picked up — it's now live." }, { status: 409 })
      }
      return NextResponse.json({ ok: true, action: "cancel" })
    }

    // mark_dismissed (cosmetic)
    const { error } = await sb
      .from("agent_messages")
      .update({ context_json: { ...ctx, dismissed: true, dismissed_by: actor, dismissed_at: nowIso }, updated_at: nowIso })
      .eq("id", id)
      .eq("recipient", "code_runner")
    if (error) throw error
    return NextResponse.json({ ok: true, action: "dismiss" })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Action failed." },
      { status: 500 },
    )
  }
}
