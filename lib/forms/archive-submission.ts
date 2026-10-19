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
import { saveFormForAccount } from "@/lib/crm-store/save-account-form"
import { getArchiveRecipe, type ArchivePlan } from "@/lib/forms/archive-registry"

/** How long a company's move may keep a package waiting before the wait counts as failed attempts (the move itself alarms after 30 min). */
export const MOVE_WAIT_BUDGET_MS = 6 * 60 * 60 * 1000

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
  // A destination that cannot be resolved is an ATTEMPT like any other failure: it is counted, so the sweep stops re-enqueuing at
  // the limit and raises its ONE staff alert instead of retrying forever with attempts stuck at 0.
  let plan: ArchivePlan
  try {
    // banking never trusts an older pin (it may hold a Drive folder id): the filer works the destination out again, now
    plan = (formType === "banking" ? null : pinnedPlan(priorMeta)) ?? (await recipe.resolvePlan(r))
  } catch (e) {
    await recordAttempt(recipe.table, submissionId, priorMeta, priorAttempts + 1, `destination unresolved: ${e instanceof Error ? e.message : String(e)}`, null)
    throw e
  }

  let result: Awaited<ReturnType<typeof saveFormToDrive>>
  let filedIn: "storage" | "folder" = "folder"
  let waitingForMove = false
  try {
    if (formType === "banking") {
      // Stop Drive (dev job 264bb882, S1d): the banking package goes through the ONE banking filer, built from the STORED ROW exactly like
      // every inline lane (same summary key, same uploads, the person the row records) — company storage (or its Drive folder if left on
      // Drive), the client's personal papers to the PERSON's own storage. The destination is worked out now, not read from an old pin.
      const { buildBankingInput } = await import("@/lib/forms/file-banking-submission")
      const { fileBankingPackage } = await import("@/lib/forms/file-banking-package")
      const pkg = await fileBankingPackage(await buildBankingInput(r as unknown as import("@/lib/forms/file-banking-submission").BankingRow, "banking-archive", { companyName: plan.companyName }))
      result = { summaryFileId: pkg.summaryFileId, copied: pkg.copied, failed: pkg.failed, skipped: [], errors: pkg.errors }
      filedIn = pkg.pinFolderId && /^(account|person)-storage:/.test(pkg.pinFolderId) ? "storage" : "folder"
      waitingForMove = !pkg.ok && pkg.retryLater
    } else if (plan.folderId === null) {
      // No folder: file the package by company (its storage, or its old folder if it has one) — never skipped.
      const accountId = typeof r["account_id"] === "string" ? (r["account_id"] as string) : null
      if (!accountId) throw new Error(`archive: ${formType} ${submissionId} has no company to file it against`)
      const saved = await saveFormForAccount({
        accountId,
        formType: plan.configKey,
        submittedData: (r.submitted_data ?? {}) as Record<string, unknown>,
        uploadPaths: plan.uploadPaths,
        meta: { token: r.token ?? plan.configKey, submittedAt: r.completed_at ?? nowIso, companyName: plan.companyName },
        bucket: plan.bucket,
        resolveBucket: recipe.resolveBucket,
      })
      if (saved.route === "none") {
        throw new Error(`archive: company ${accountId} (${plan.companyName ?? "?"}) has no storage and no folder — there is nowhere to archive its ${formType} package`)
      }
      result = saved.result
      filedIn = saved.route === "store" ? "storage" : "folder"
    } else {
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
        // A form with MORE THAN ONE upload origin (e.g. closure: external form →
        // closure-uploads, portal wizard → onboarding-uploads) supplies a per-path
        // bucket resolver so BOTH origins download from the right bucket. plan.bucket
        // is the default for forms with a single origin.
        {
          bucket: plan.bucket,
          resolveBucket: recipe.resolveBucket,
          fileNameOf: recipe.fileNameOf?.(r),
          // ITIN is person-keyed: a person whose files live in the new storage gets the package there (no Drive folder)
          person: formType === "itin" && typeof r["contact_id"] === "string" ? { contactId: r["contact_id"] as string, viaAccountId: (r["account_id"] as string | null) ?? null, name: plan.companyName } : undefined,
        },
      )
    }
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
    // A company that is being moved to the new storage is WAITING, not failing: the wait does not use up attempts (the move has its own
    // alarm), until it has lasted longer than MOVE_WAIT_BUDGET_MS — then it counts like any other failure so the sweep alerts once.
    const waitingSince = typeof priorMeta["waiting_since"] === "string" ? (priorMeta["waiting_since"] as string) : nowIso
    const waitedTooLong = waitingForMove && Date.now() - Date.parse(waitingSince) > MOVE_WAIT_BUDGET_MS
    const countIt = !waitingForMove || waitedTooLong
    await recordAttempt(recipe.table, submissionId, priorMeta, countIt ? priorAttempts + 1 : priorAttempts, detail || "unknown partial failure", result, { waiting_since: waitingForMove ? waitingSince : undefined })
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
        waiting_since: undefined,
        attempts: priorAttempts + 1,
        last_attempt_at: nowIso,
        last_error: null,
        summary_file_id: result.summaryFileId,
        copied: result.copied,
        skipped: result.skipped,
        drive_folder_id: plan.folderId,
        filed_in: filedIn,
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
  extra?: Record<string, unknown>,
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
          ...(extra ?? {}),
        },
      } as never)
      .eq("id", submissionId)
  } catch (e) {
    console.error("[forms/archive-submission] failed to record attempt meta (non-fatal):", e)
  }
}
