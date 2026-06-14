import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser, getUserDisplayName } from "@/lib/auth"
import { NextResponse } from "next/server"

/**
 * POST /api/code-tasks/[id]/input   body: { text }
 * Queues an admin turn for a live interactive code-task session. The Mac Mini
 * runner polls code_task_inputs and pipes pending rows into the session's stdin.
 * Sending the END sentinel (text='__END_SESSION__') tells the runner to close
 * stdin and finish (then push the branch). Admin-only.
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
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (!text) return NextResponse.json({ error: "Message text is required." }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabaseAdmin as any

  // Only accept input while the session is actually running.
  const { data: task } = await sb
    .from("agent_messages")
    .select("status")
    .eq("id", id)
    .eq("recipient", "code_runner")
    .maybeSingle()
  if (!task) return NextResponse.json({ error: "Code task not found" }, { status: 404 })
  if (task.status !== "processing") {
    return NextResponse.json({ error: "This session is no longer live." }, { status: 409 })
  }

  // Next seq for this task (max + 1) — code_task_inputs is UNIQUE(task_id, seq).
  const { data: last } = await sb
    .from("code_task_inputs")
    .select("seq")
    .eq("task_id", id)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextSeq = (last?.seq ?? -1) + 1

  const { error } = await sb.from("code_task_inputs").insert({
    task_id: id,
    seq: nextSeq,
    text,
    status: "pending",
    created_by: getUserDisplayName(user),
  })
  if (error) return NextResponse.json({ error: error.message || "Failed to send" }, { status: 500 })

  return NextResponse.json({ ok: true, seq: nextSeq })
}
