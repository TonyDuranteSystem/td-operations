import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { NextResponse } from "next/server"

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tasks = (data ?? []).map((r: any) => ({
    id: r.id,
    title: r.context_json?.title ?? r.subject ?? "Code task",
    status: r.status,
    code_branch: r.context_json?.code_branch ?? null,
    is_promote: !!r.context_json?.promote_branch,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }))
  return NextResponse.json({ tasks })
}
