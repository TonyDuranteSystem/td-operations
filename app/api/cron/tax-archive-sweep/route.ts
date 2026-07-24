/**
 * Tax-submission Drive-archival BACKSTOP sweep.
 *
 * job_queue retries a single archive per submission; this cron is the discovery
 * net — it finds submissions whose Drive archival never completed and re-enqueues
 * the durable archive job, or (once attempts are exhausted) raises ONE loud staff
 * alert so a stuck package is never silently missing again. See lib/tax/
 * archive-sweep.ts for the predicate + its forward-only cutoff invariant.
 *
 * Safety:
 * - DRY-RUN BY DEFAULT: enqueues/alerts only when TAX_ARCHIVE_SWEEP_DRY_RUN is
 *   the string "false".
 * - Forward-only cutoff — never mass-reprocesses the pre-feature backlog.
 * - Grace window — never races a live archive job.
 * - Attempt cap → alert-only (no infinite retry); alerted-key → no alert storm.
 * - Enqueue is idempotent (skips an already-queued / already-archived row).
 */
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { reportSystemError } from "@/lib/system-errors"
import { postTeamMessage } from "@/lib/team/post-message"
import { enqueueTaxArchiveJob } from "@/lib/tax/archive-enqueue"
import {
  decideArchiveSweep,
  ARCHIVE_SWEEP_CUTOFF_ISO,
  ARCHIVE_SWEEP_MAX_PER_RUN,
  ARCHIVE_SWEEP_ALERTED_KEY,
  ARCHIVE_SWEEP_CHANNEL,
  type ArchiveSweepRow,
} from "@/lib/tax/archive-sweep"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const ENDPOINT = "/api/cron/tax-archive-sweep"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const dryRun = process.env.TAX_ARCHIVE_SWEEP_DRY_RUN !== "false"
  const now = new Date()

  // Candidates: never-archived, forward of the cutoff. The partial index makes
  // this cheap. Real-submission / grace / attempt filtering happens in decide().
  const { data: rows, error } = await supabaseAdmin
    .from("tax_return_submissions")
    .select("id, account_id, status, review_status, created_at, drive_archived_at, drive_archive_meta")
    .is("drive_archived_at", null)
    .gte("created_at", ARCHIVE_SWEEP_CUTOFF_ISO)
    .order("created_at", { ascending: true })
    .limit(200)

  if (error) {
    await reportSystemError({ source: "server", route: ENDPOINT, message: `candidate query failed: ${error.message}` }).catch(() => {})
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let enqueued = 0
  const stuck: string[] = []
  const enqueuedIds: string[] = []

  for (const r of (rows ?? []) as unknown as ArchiveSweepRow[]) {
    const action = decideArchiveSweep(r, now)
    if (action === "skip") continue

    if (action === "enqueue") {
      if (enqueued >= ARCHIVE_SWEEP_MAX_PER_RUN) continue
      if (!dryRun) {
        try {
          const res = await enqueueTaxArchiveJob({ submissionId: r.id, accountId: r.account_id, createdBy: "archive_sweep" })
          if (res.status === "enqueued") { enqueued++; enqueuedIds.push(r.id) }
        } catch (e) {
          console.error(`[tax-archive-sweep] enqueue failed for ${r.id}:`, e)
        }
      } else {
        enqueued++; enqueuedIds.push(r.id)
      }
    } else if (action === "alert") {
      stuck.push(r.id)
      if (!dryRun) {
        // Mark alerted so we don't re-alert this row every run.
        try {
          await supabaseAdmin
            .from("tax_return_submissions")
            .update({ drive_archive_meta: { ...(r.drive_archive_meta ?? {}), [ARCHIVE_SWEEP_ALERTED_KEY]: true } } as never)
            .eq("id", r.id)
        } catch { /* best-effort */ }
      }
    }
  }

  // One digest alert per run for stuck rows — loud, and durable via system_errors
  // so a failed chat post can't re-hide the failure.
  if (stuck.length > 0) {
    const msg = `⚠️ @Luca ${stuck.length} tax submission(s) could NOT be archived to Google Drive after repeated attempts — their package is missing from the client folder and needs a manual check. Submission ids: ${stuck.join(", ")}`
    if (!dryRun) {
      await postTeamMessage({ channel: ARCHIVE_SWEEP_CHANNEL, message: msg }).catch(e =>
        console.error("[tax-archive-sweep] team alert post failed:", e))
    }
    await reportSystemError({
      source: "server",
      route: ENDPOINT,
      message: `${stuck.length} submissions stuck un-archived: ${stuck.join(", ")}`,
    }).catch(() => {})
  }

  const summary = { dryRun, candidates: (rows ?? []).length, enqueued, enqueuedIds, stuck }
  logCron({ endpoint: ENDPOINT, status: "success", duration_ms: Date.now() - startTime, details: summary })
  return NextResponse.json({ ok: true, ...summary })
}
