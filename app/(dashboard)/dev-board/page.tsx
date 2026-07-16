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

  const { data, error } = await db
    .from("dev_tasks")
    .select(
      "id, title, type, status, priority, channel, milestones, summary_plain, business_impact, simple_next_step, owner, due_date, origin_url, related_files, description, findings, plan, decisions, blockers, progress_log, parent_task_id, created_at, updated_at, completed_at, knowledge_ref, knowledge_status",
    )
    .neq("status", "cancelled")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(500)

  // A failed select must NOT render as an empty board (it would look like every
  // job vanished — e.g. code deployed before the plain-fields migration ran).
  if (error) console.error("[dev-board] jobs query failed:", error.message)

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
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Couldn&apos;t load the board: {error.message}. The jobs are safe in the tracker — this is a
          loading problem, not lost work (check that the latest database migration has been applied).
        </div>
      ) : (
        <DevBoard jobs={jobs} initialChannel={sp.channel ?? ""} />
      )}
    </div>
  )
}
