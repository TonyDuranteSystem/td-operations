/**
 * Dev Board — the per-channel job board (dev-tracker). Reads dev_tasks (the
 * single source of truth) and renders lanes + a detail drawer. Replaces the old
 * dev-tasks table that lived under Settings. Staff-only via the dashboard layout.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createClient } from "@/lib/supabase/server"
import { DevBoard, type DevJob } from "@/components/dev-board/dev-board"

export const dynamic = "force-dynamic"

// dev_tasks tracker columns aren't in the generated types yet (prod migrates later).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export default async function DevBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string }>
}) {
  const sp = await searchParams

  // Mark the board as "seen" for this user so the sidebar notification clears.
  try {
    const {
      data: { user },
    } = await createClient().auth.getUser()
    if (user) {
      await db
        .from("dev_board_reads")
        .upsert({ user_id: user.id, last_seen_at: new Date().toISOString() }, { onConflict: "user_id" })
    }
  } catch {
    /* non-blocking */
  }

  const { data } = await db
    .from("dev_tasks")
    .select(
      "id, title, type, status, priority, channel, milestones, summary_plain, description, findings, plan, decisions, blockers, progress_log, parent_task_id, created_at, updated_at, completed_at, knowledge_ref, knowledge_status",
    )
    .neq("status", "cancelled")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(500)

  const jobs: DevJob[] = (data || []) as DevJob[]

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-zinc-900">Dev Board</h1>
        <p className="text-sm text-zinc-500">
          Every dev job across the channels — request, findings, approved plan, milestones and status.
          Sessions keep this current so nothing is lost.
        </p>
      </div>
      <DevBoard jobs={jobs} initialChannel={sp.channel ?? ""} />
    </div>
  )
}
