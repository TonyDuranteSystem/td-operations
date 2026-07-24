/**
 * Durable Google-Drive archival for ONE tax submission (2026-07-24).
 *
 * Born from the Carasso incident: the old inline "best-effort, 120s race" copy
 * inside tax_form_setup swallowed the folder-read error (silent "no folder"
 * skip), abandoned on timeout, never retried, and never alerted — so a client's
 * package went missing with no trace. This module is the single archival unit,
 * run as its OWN durable job (`archive_tax_submission`) so it inherits job_queue
 * retry/backoff/final-notify and re-runs ONLY the Drive work — never the emails.
 *
 * Contract (every guard the council named):
 *  - Folder read distinguishes a FAILED read (throw → the job retries) from a
 *    GENUINELY absent folder (throw + loud, NEVER a silent skip).
 *  - Per-file bucket resolution so external-form files (tax-form-uploads) AND
 *    portal-wizard files (onboarding-uploads) are both found.
 *  - Year pinned explicitly (never a calendar guess) so files land in 3.Tax/{year}.
 *  - Marker set ONLY on FULL success: summary saved AND zero failed AND zero
 *    errors. Partial/misfiled leaves drive_archived_at NULL so the sweep re-runs.
 *  - Idempotent: already-archived → no-op; saveFormToDrive upserts by stable name.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { saveFormToDrive } from "@/lib/form-to-drive"
import { isWizardUploadPath } from "@/lib/portal/wizard-uploads"

export interface ArchiveResult {
  status: "archived" | "already_archived" | "no_submission"
  submissionId: string
  copied?: number
  skipped?: number
}

/** The two buckets a tax submission's files can live in. */
export function bucketForTaxUploadPath(path: string): string {
  // Portal-wizard file fields upload to onboarding-uploads; everything else is
  // a legacy EXTERNAL tax-form artifact in tax-form-uploads.
  return isWizardUploadPath(path) ? "onboarding-uploads" : "tax-form-uploads"
}

interface SubmissionRow {
  id: string
  account_id: string | null
  token: string
  tax_year: number | null
  submitted_data: Record<string, unknown> | null
  upload_paths: unknown
  drive_archived_at: string | null
  drive_archive_meta: Record<string, unknown> | null
}

/**
 * Archive one submission's package to the account's Drive folder. THROWS on any
 * unrecovered failure (folder read error, absent folder, partial copy, misfile)
 * so the enclosing job_queue job retries and, on final failure, alerts. Records
 * the attempt in drive_archive_meta either way.
 */
export async function archiveTaxSubmission(submissionId: string): Promise<ArchiveResult> {
  const { data: sub, error: subErr } = await supabaseAdmin
    .from("tax_return_submissions")
    .select("id, account_id, token, tax_year, submitted_data, upload_paths, drive_archived_at, drive_archive_meta")
    .eq("id", submissionId)
    .maybeSingle()
  if (subErr) throw new Error(`archive: submission read failed (retryable): ${subErr.message}`)
  if (!sub) return { status: "no_submission", submissionId }
  const s = sub as unknown as SubmissionRow

  if (s.drive_archived_at) return { status: "already_archived", submissionId }
  if (!s.account_id) throw new Error(`archive: submission ${submissionId} has no account_id (contact-scoped) — cannot resolve a Drive folder`)

  // ── Folder resolution: a READ ERROR must NEVER be read as "no folder". ──
  const { data: acc, error: accErr } = await supabaseAdmin
    .from("accounts")
    .select("drive_folder_id, company_name")
    .eq("id", s.account_id)
    .maybeSingle()
  if (accErr) throw new Error(`archive: account read failed (retryable): ${accErr.message}`)
  if (!acc) throw new Error(`archive: account ${s.account_id} not found`)
  if (!acc.drive_folder_id) throw new Error(`archive: account ${s.account_id} (${acc.company_name ?? "?"}) has NO drive_folder_id — needs a Drive folder before its tax package can be archived`)

  const uploadPaths = Array.isArray(s.upload_paths)
    ? (s.upload_paths as unknown[]).filter((p): p is string => typeof p === "string")
    : []
  const nowIso = new Date().toISOString()
  const priorAttempts = Number((s.drive_archive_meta ?? {})["attempts"]) || 0

  let result: Awaited<ReturnType<typeof saveFormToDrive>>
  try {
    result = await saveFormToDrive(
      "tax_return",
      (s.submitted_data ?? {}) as Record<string, unknown>,
      uploadPaths,
      acc.drive_folder_id,
      {
        token: s.token,
        submittedAt: nowIso,
        companyName: acc.company_name ?? undefined,
        year: s.tax_year ?? undefined, // pinned — never a calendar guess
      },
      { resolveBucket: bucketForTaxUploadPath },
    )
  } catch (e) {
    await recordAttempt(submissionId, priorAttempts + 1, `save threw: ${e instanceof Error ? e.message : String(e)}`, null)
    throw e
  }

  // ── FULL success only: summary saved AND every file copied AND no errors. ──
  const fullSuccess =
    result.summaryFileId !== null && result.failed.length === 0 && result.errors.length === 0

  if (!fullSuccess) {
    const detail = [
      result.summaryFileId ? null : "summary PDF not saved",
      result.failed.length ? `${result.failed.length} file(s) failed: ${result.failed.join("; ")}` : null,
      result.errors.length ? `errors: ${result.errors.join("; ")}` : null,
    ].filter(Boolean).join(" | ")
    await recordAttempt(submissionId, priorAttempts + 1, detail || "unknown partial failure", result)
    throw new Error(`archive: ${submissionId} not fully archived (retryable) — ${detail}`)
  }

  // Success — set the marker (this is what the sweep keys on) + clean meta.
  const { error: markErr } = await supabaseAdmin
    .from("tax_return_submissions")
    // as never: drive_archived_at / drive_archive_meta are new columns not yet
    // in the generated types (migration 20260724-1900). Remove after gen:types.
    .update({
      drive_archived_at: nowIso,
      drive_archive_meta: {
        attempts: priorAttempts + 1,
        last_attempt_at: nowIso,
        last_error: null,
        summary_file_id: result.summaryFileId,
        copied: result.copied,
        skipped: result.skipped,
        drive_folder_id: acc.drive_folder_id,
      },
    } as never)
    .eq("id", submissionId)
  if (markErr) throw new Error(`archive: succeeded but failed to set marker (retryable): ${markErr.message}`)

  return { status: "archived", submissionId, copied: result.copied.length, skipped: result.skipped.length }
}

async function recordAttempt(
  submissionId: string,
  attempts: number,
  lastError: string,
  result: Awaited<ReturnType<typeof saveFormToDrive>> | null,
): Promise<void> {
  try {
    await supabaseAdmin
      .from("tax_return_submissions")
      .update({
        drive_archive_meta: {
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
    console.error("[archive-submission] failed to record attempt meta (non-fatal):", e)
  }
}
