/**
 * Non-tax form Drive-archival BACKSTOP sweep (banking first, then the rest).
 *
 * job_queue retries a single archive per submission; this cron is the discovery
 * net — for each registered form recipe it finds submissions whose archival never
 * completed and re-enqueues the durable archive job, or (once attempts are
 * exhausted) raises ONE loud staff alert so a stuck package is never silently
 * missing. See lib/forms/archive-sweep.ts for the predicate + forward-only cutoff.
 *
 * Safety:
 * - DRY-RUN BY DEFAULT: enqueues/alerts only when FORMS_ARCHIVE_SWEEP_DRY_RUN is
 *   the string "false".
 * - PER-FORM / PER-TABLE queries — never one shared SELECT across tables.
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
import { ARCHIVE_RECIPES } from "@/lib/forms/archive-registry"
import { enqueueFormArchiveJob } from "@/lib/forms/archive-enqueue"
import {
  decideFormArchiveSweep,
  FORM_ARCHIVE_SWEEP_CUTOFF_ISO,
  FORM_ARCHIVE_SWEEP_MAX_PER_RUN,
  FORM_ARCHIVE_SWEEP_ALERTED_KEY,
  FORM_ARCHIVE_SWEEP_CHANNEL,
} from "@/lib/forms/archive-sweep"
import { collectSweepCandidates } from "@/lib/archive/skip-no-drive-folder"

export const dynamic = "force-dynamic"
export const maxDuration = 120

const ENDPOINT = "/api/cron/forms-archive-sweep"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const dryRun = process.env.FORMS_ARCHIVE_SWEEP_DRY_RUN !== "false"
  const now = new Date()

  let enqueued = 0
  const enqueuedIds: string[] = []
  const stuck: string[] = []
  const perForm: Record<string, { candidates: number; enqueued: number; stuck: number; skippedNoFolder: number }> = {}
  let skippedNoFolder = 0

  for (const recipe of Object.values(ARCHIVE_RECIPES)) {
    const stats = { candidates: 0, enqueued: 0, stuck: 0, skippedNoFolder: 0 }
    perForm[recipe.formType] = stats

    // Cast: recipe.table is a runtime string; the typed client needs a table
    // literal (every recipe.table IS a real submission table).
    const tbl = recipe.table as "banking_submissions"
    // Only the banking archive resolves the company's own folder (itin / closure resolve others). A company with no folder
    // cannot be archived by it (it would throw on every run): such rows are left alone and counted, and they never take a
    // place in the window of 200 — pages are read until 200 real rows are found (or the data runs out).
    const skipNoFolder = recipe.formType === "banking"
    const pages = await collectSweepCandidates<Record<string, unknown> & { account_id?: string | null }>(
      (from, to) =>
        supabaseAdmin
          .from(tbl)
          .select(recipe.selectColumns)
          .is("drive_archived_at", null)
          .gte("created_at", FORM_ARCHIVE_SWEEP_CUTOFF_ISO)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{ data: Array<Record<string, unknown> & { account_id?: string | null }> | null; error: { message: string } | null }>,
      { limit: 200, pageSize: 200, maxPages: skipNoFolder ? 25 : 1 },
      skipNoFolder ? undefined : async () => new Set<string>(),
    )

    if (pages.readError) {
      await reportSystemError({ source: "server", route: ENDPOINT, message: `${recipe.formType} candidate query failed: ${pages.readError}` }).catch(() => {})
      continue
    }
    if (pages.lookupError) {
      await reportSystemError({ source: "server", route: ENDPOINT, message: `could not check which accounts have a folder: ${pages.lookupError}` }).catch(() => {})
    }
    const formRows = pages.keep as Record<string, unknown>[]
    stats.skippedNoFolder = pages.skipped
    skippedNoFolder += pages.skipped

    for (const raw of formRows) {
      stats.candidates++
      const action = decideFormArchiveSweep(raw, recipe, now)
      if (action === "skip") continue

      if (action === "enqueue") {
        if (enqueued >= FORM_ARCHIVE_SWEEP_MAX_PER_RUN) continue
        if (!dryRun) {
          try {
            const res = await enqueueFormArchiveJob({ formType: recipe.formType, submissionId: String(raw.id), createdBy: "forms_archive_sweep" })
            if (res.status === "enqueued") { enqueued++; stats.enqueued++; enqueuedIds.push(String(raw.id)) }
          } catch (e) {
            console.error(`[forms-archive-sweep] enqueue failed for ${recipe.formType} ${String(raw.id)}:`, e)
          }
        } else {
          enqueued++; stats.enqueued++; enqueuedIds.push(String(raw.id))
        }
      } else if (action === "alert") {
        stuck.push(`${recipe.formType}:${String(raw.id)}`); stats.stuck++
        if (!dryRun) {
          try {
            await supabaseAdmin
              .from(tbl)
              .update({ drive_archive_meta: { ...((raw.drive_archive_meta as Record<string, unknown> | null) ?? {}), [FORM_ARCHIVE_SWEEP_ALERTED_KEY]: true } } as never)
              .eq("id", String(raw.id))
          } catch { /* best-effort */ }
        }
      }
    }
  }

  // One digest alert per run for stuck rows — loud, and durable via system_errors
  // so a failed chat post can't re-hide the failure.
  if (stuck.length > 0) {
    const msg = `⚠️ @Luca ${stuck.length} form submission(s) could NOT be archived to Google Drive after repeated attempts — their package is missing from the client folder and needs a manual check: ${stuck.join(", ")}`
    if (!dryRun) {
      await postTeamMessage({ channel: FORM_ARCHIVE_SWEEP_CHANNEL, message: msg }).catch(e =>
        console.error("[forms-archive-sweep] team alert post failed:", e))
    }
    await reportSystemError({
      source: "server",
      route: ENDPOINT,
      message: `${stuck.length} form submissions stuck un-archived: ${stuck.join(", ")}`,
    }).catch(() => {})
  }

  const summary = { dryRun, skippedNoFolder, enqueued, enqueuedIds, stuck, perForm }
  logCron({ endpoint: ENDPOINT, status: "success", duration_ms: Date.now() - startTime, details: summary })
  return NextResponse.json({ ok: true, ...summary })
}
