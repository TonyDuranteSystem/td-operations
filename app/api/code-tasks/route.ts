import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser, getUserDisplayName } from "@/lib/auth"
import { runnerHealth, isTaskStuck } from "@/lib/code-tasks/health"
import { NextResponse } from "next/server"

// Must match INSTANCE_ID in scripts/mac-mini/code-task-runner.mjs (its heartbeat key).
const RUNNER_INSTANCE_ID = "code-runner-mac-mini"

/**
 * GET /api/code-tasks
 * List recent Slack code tasks (agent_messages rows, recipient='code_runner') for
 * the Code Tasks index. Admin-only; service-role read.
 */
export async function GET() {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as any
  const { data, error } = await sb
    .from("agent_messages")
    .select("id, subject, status, context_json, created_at, updated_at")
    .eq("recipient", "code_runner")
    .order("updated_at", { ascending: false })
    .limit(50)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Runner liveness — the Mac Mini upserts its heartbeat into hermes_instances.
  const { data: hb } = await sb
    .from("hermes_instances")
    .select("last_heartbeat")
    .eq("instance_id", RUNNER_INSTANCE_ID)
    .maybeSingle()
  const now = Date.now()
  const runner = runnerHealth(hb?.last_heartbeat ?? null, now)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tasks = (data ?? [])
    // Hide tasks the admin dismissed from the CRM (cosmetic — the row is kept).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((r: any) => !r.context_json?.dismissed)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any) => ({
      id: r.id,
      title: r.context_json?.title ?? r.subject ?? "Code task",
      status: r.status,
      code_branch: r.context_json?.code_branch ?? null,
      is_promote: !!r.context_json?.promote_branch,
      created_at: r.created_at,
      updated_at: r.updated_at,
      stuck: isTaskStuck({ status: r.status, created_at: r.created_at, updated_at: r.updated_at }, now),
    }))
  return NextResponse.json({ tasks, runner })
}

/**
 * POST /api/code-tasks   body: { title?, instructions }
 * Start a code task directly from the CRM (not only from Slack). Inserts a pending
 * code_runner row the Mac Mini will claim; no Slack channel context, so it reports
 * only in the CRM viewer (live transcript). Admin-only.
 */
export async function POST(req: Request) {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const instructions = typeof body.instructions === "string" ? body.instructions.trim() : ""
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : "CRM code task"
  if (instructions.length < 10) {
    return NextResponse.json({ error: "Describe the task in a bit more detail (at least 10 characters)." }, { status: 400 })
  }
  if (instructions.length > 8000) {
    return NextResponse.json({ error: "Instructions are too long (max 8000 characters)." }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as any
  const { data: inserted, error } = await sb
    .from("agent_messages")
    .insert({
      sender: "claude",
      recipient: "code_runner",
      subject: title,
      body: instructions,
      status: "pending",
      context_json: { title, source: "crm", created_by: getUserDisplayName(user) },
    })
    .select("id")
    .single()
  if (error) return NextResponse.json({ error: error.message || "Failed to create task." }, { status: 500 })
  return NextResponse.json({ ok: true, id: inserted?.id })
}
