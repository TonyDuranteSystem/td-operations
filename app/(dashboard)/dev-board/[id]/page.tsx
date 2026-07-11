/**
 * Dev Board — per-job "board inside the board". Opens one job as its own stage
 * board: milestone columns (desktop) / stacked (mobile), each showing that
 * stage's trail + settled result. The stage set adapts to the job's type.
 */
import Link from "next/link"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { resolveStageSet, mergeStageSets, stageSetFromMetadata } from "@/lib/dev-tracker/stage-sets"
import type { StageSet } from "@/lib/dev-tracker/milestones"
import { JobStageBoard } from "@/components/dev-board/job-stage-board"
import type { DevJob } from "@/components/dev-board/types"

export const dynamic = "force-dynamic"

// dev_tasks tracker columns aren't in the generated types yet (prod migrates later).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const JOB_FIELDS =
  "id, title, type, status, priority, channel, milestones, summary_plain, description, findings, plan, decisions, blockers, progress_log, parent_task_id, created_at, updated_at, completed_at"

export default async function JobBoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const [{ data: job }, { data: catalogRows }, { data: kids }] = await Promise.all([
    db.from("dev_tasks").select(JOB_FIELDS).eq("id", id).single(),
    db
      .from("catalog_entries")
      .select("slug, display_name, metadata")
      .eq("catalog_id", "dev_stage_sets")
      .eq("status", "active"),
    db.from("dev_tasks").select(JOB_FIELDS).eq("parent_task_id", id),
  ])

  if (!job) {
    return (
      <div className="p-6">
        <Link href="/dev-board" className="text-sm text-blue-600 hover:underline">
          ← Dev Board
        </Link>
        <p className="mt-4 text-sm text-zinc-500">Job not found.</p>
      </div>
    )
  }

  // Build the catalog stage-set map, merge over built-ins, resolve for this job's type.
  const catalog: Record<string, StageSet> = {}
  for (const row of (catalogRows || []) as Array<{ slug: string; display_name: string; metadata: unknown }>) {
    const set = stageSetFromMetadata(row.slug, row.display_name, row.metadata)
    if (set) catalog[row.slug] = set
  }
  const stageSet = resolveStageSet((job as DevJob).type, mergeStageSets(catalog))

  return (
    <div className="p-4 lg:p-6">
      <JobStageBoard job={job as DevJob} stageSet={stageSet} childrenJobs={(kids || []) as DevJob[]} />
    </div>
  )
}
