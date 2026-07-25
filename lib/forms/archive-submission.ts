/**
 * Durable Google-Drive archival for ONE form submission — the GENERIC engine
 * (2026-07-24). Sibling of lib/tax/archive-submission.ts, which stays untouched
 * (it shipped hours ago and is the correctness reference). This one serves the
 * OTHER forms via per-form recipes (lib/forms/archive-registry.ts).
 *
 * The reliability CONTRACT lives here, once, for every form:
 *  - Prefer the plan PINNED at submission time (folder id, bucket, config key,
 *    upload paths) so deferred archival never re-derives a folder from a mutable
 *    name or re-guesses the bucket (the two-copies-in-two-folders hazard the
 *    council flagged). Fall back to the recipe's resolvePlan() only when no pin
 *    exists (the sweep / backstop path).
 *  - Folder resolution distinguishes a FAILED read (throw → retry) from a
 *    GENUINELY absent destination (throw + loud) — never a silent skip.
 *  - Marker (drive_archived_at) set ONLY on FULL success: summary saved AND zero
 *    failed AND zero errors. Partial/misfiled stays NULL so the sweep re-runs.
 *  - Meta is read-MERGED (never whole-object replaced) so an attempt write can't
 *    clobber a pinned plan or the sweep's alerted flag.
 *  - Idempotent: already-archived → no-op; saveFormToDrive upserts by stable name
 *    so the durable job and the inline best-effort save dedupe in the same folder.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { saveFormToDrive } from "@/lib/form-to-drive"
import { getArchiveRecipe, type ArchivePlan } from "@/lib/forms/archive-registry"

export interface FormArchiveResult {
  status: "archived" | "already_archived" | "no_submission" | "not_real"
  formType: string
  submissionId: string
  copied?: number
  skipped?: number
}

interface CommonRow {
  id: string
  token?: string | null
  submitted_data?: Record<string, unknown> | null
  completed_at?: string | null
  drive_archived_at?: string | null
  drive_archive_meta?: Record<string, unknown> | null
  [k: string]: unknown
}

/** Rebuild a pinned ArchivePlan from meta written at submission time, or null. */
function pinnedPlan(meta: Record<string, unknown> | null | undefined): ArchivePlan | null {
  const p = (meta ?? {})["pinned_plan"] as Partial<ArchivePlan> | undefined
  if (!p || typeof p.folderId !== "string" || !p.folderId) return null
  if (typeof p.bucket !== "string" || !p.bucket) return null
  if (typeof p.configKey !== "string" || !p.configKey) return null
  return {
    folderId: p.folderId,
    bucket: p.bucket,
    configKey: p.configKey,
    uploadPaths: Array.isArray(p.uploadPaths) ? p.uploadPaths.filter((x): x is string => typeof x === "string") : [],
    companyName: typeof p.companyName === "string" ? p.companyName : undefined,
  }
}

/**
 * Archive one form submission's package. THROWS on any unrecovered failure (read
 * error, absent destination, partial copy, misfile) so the enclosing job_queue
 * job retries and, on final failure, the sweep alerts. Records the attempt in
 * drive_archive_meta either way (read-merged).
 */
export async function archiveFormSubmission(formType: string, submissionId: string): Promise<FormArchiveResult> {
  const recipe = getArchiveRecipe(formType)
  if (!recipe) throw new Error(`archive: no recipe registered for form type "${formType}"`)

  // Cast: recipe.table is a runtime string; the typed client needs a table
  // literal. We cast to a concrete submission table (valid — every recipe.table
  // IS a real submission table) and read the row through our own CommonRow shape.
  const tbl = recipe.table as "banking_submissions"
  const { data: row, error: rowErr } = await supabaseAdmin
    .from(tbl)
    .select(recipe.selectColumns)
    .eq("id", submissionId)
    .maybeSingle()
  if (rowErr) throw new Error(`archive: ${recipe.table} read failed (retryable): ${rowErr.message}`)
  if (!row) return { status: "no_submission", formType, submissionId }
  const r = row as unknown as CommonRow

  if (r.drive_archived_at) return { status: "already_archived", formType, submissionId }
  if (!recipe.isReal(r)) return { status: "not_real", formType, submissionId }

  const priorMeta = (r.drive_archive_meta ?? {}) as Record<string, unknown>
  const priorAttempts = Number(priorMeta["attempts"]) || 0
  const nowIso = new Date().toISOString()

  // Prefer the plan pinned at submission; else derive it fresh (sweep path).
  const plan = pinnedPlan(priorMeta) ?? (await recipe.resolvePlan(r))

  let result: Awaited<ReturnType<typeof saveFormToDrive>>
  try {
    result = await saveFormToDrive(
      plan.configKey,
      (r.submitted_data ?? {}) as Record<string, unknown>,
      plan.uploadPaths,
      plan.folderId,
      {
        token: r.token ?? plan.configKey,
        submittedAt: r.completed_at ?? nowIso,
        companyName: plan.companyName,
      },
      { bucket: plan.bucket },
    )
  } catch (e) {
    await recordAttempt(recipe.table, submissionId, priorMeta, priorAttempts + 1, `save threw: ${e instanceof Error ? e.message : String(e)}`, null)
    throw e
  }

  const fullSuccess = result.summaryFileId !== null && result.failed.length === 0 && result.errors.length === 0
  if (!fullSuccess) {
    const detail = [
      result.summaryFileId ? null : "summary PDF not saved",
      result.failed.length ? `${result.failed.length} file(s) failed: ${result.failed.join("; ")}` : null,
      result.errors.length ? `errors: ${result.errors.join("; ")}` : null,
    ].filter(Boolean).join(" | ")
    await recordAttempt(recipe.table, submissionId, priorMeta, priorAttempts + 1, detail || "unknown partial failure", result)
    throw new Error(`archive: ${formType} ${submissionId} not fully archived (retryable) — ${detail}`)
  }

  // FULL success — set the marker (what the sweep keys on), MERGING meta so a
  // pinned plan / prior detail is preserved for inspection.
  const { error: markErr } = await supabaseAdmin
    .from(tbl)
    // as never: drive_archived_at / drive_archive_meta are new columns not yet in
    // the generated types (per-form marker migrations). Remove after gen:types.
    .update({
      drive_archived_at: nowIso,
      drive_archive_meta: {
        ...priorMeta,
        attempts: priorAttempts + 1,
        last_attempt_at: nowIso,
        last_error: null,
        summary_file_id: result.summaryFileId,
        copied: result.copied,
        skipped: result.skipped,
        drive_folder_id: plan.folderId,
      },
    } as never)
    .eq("id", submissionId)
  if (markErr) throw new Error(`archive: succeeded but failed to set marker (retryable): ${markErr.message}`)

  return { status: "archived", formType, submissionId, copied: result.copied.length, skipped: result.skipped.length }
}

async function recordAttempt(
  table: string,
  submissionId: string,
  priorMeta: Record<string, unknown>,
  attempts: number,
  lastError: string,
  result: Awaited<ReturnType<typeof saveFormToDrive>> | null,
): Promise<void> {
  try {
    await supabaseAdmin
      .from(table as "banking_submissions")
      .update({
        drive_archive_meta: {
          ...priorMeta, // MERGE — never drop the pinned plan or the alerted flag
          attempts,
          last_attempt_at: new Date().toISOString(),
          last_error: lastError,
          copied: result?.copied ?? [],
          failed: result?.failed ?? [],
          errors: result?.errors ?? [],
        },
      } as never)
      .eq("id", submissionId)
  } catch (e) {
    console.error("[forms/archive-submission] failed to record attempt meta (non-fatal):", e)
  }
}
