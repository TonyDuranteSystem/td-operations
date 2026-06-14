import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { NextResponse } from "next/server"

/**
 * GET /api/code-tasks/[id]?since=<seq>
 * Live transcript feed for a Slack code task (agent_messages row, recipient='code_runner').
 * Returns the task header + every code_task_events row with seq > `since`, ordered.
 * The viewer polls this every ~2s with the last seq it has. Admin-only; uses the
 * service-role client server-side (no client RLS dependency).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const since = Number(new URL(req.url).searchParams.get("since") ?? "-1")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as any

  const { data: task } = await sb
    .from("agent_messages")
    .select("id, subject, status, context_json, reply, error_text")
    .eq("id", id)
    .eq("recipient", "code_runner")
    .maybeSingle()
  if (!task) return NextResponse.json({ error: "Code task not found" }, { status: 404 })

  const { data: events, error: evErr } = await sb
    .from("code_task_events")
    .select("seq, event_type, payload, created_at")
    .eq("task_id", id)
    .gt("seq", since)
    .order("seq", { ascending: true })
    .limit(1000)
  if (evErr) return NextResponse.json({ error: evErr.message }, { status: 500 })

  const ctx = task.context_json || {}
  return NextResponse.json({
    task: {
      id: task.id,
      title: ctx.title ?? task.subject ?? "Code task",
      status: task.status,
      session_id: ctx.session_id ?? null,
      code_branch: ctx.code_branch ?? null,
      reply: task.reply ?? null,
      error_text: task.error_text ?? null,
    },
    events: events ?? [],
  })
}
