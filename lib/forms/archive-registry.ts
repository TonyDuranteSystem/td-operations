/**
 * Per-form archival RECIPES — the single place that knows, for each form, WHERE
 * its package belongs in Drive and WHICH bucket/config its files use (2026-07-24).
 *
 * Born from the council review of "extend the tax durable-archival to the other
 * forms": the five forms do NOT all file the tax way. Only tax/banking file to
 * the account's company folder; formation/onboarding/closure file to a
 * `Leads/{name}` folder, and ITIN files under the PERSON, never a company. A
 * single tax-shaped resolver would misfile or fail them. So the reliability
 * CONTRACT lives once in the generic engine (archive-submission.ts) and each form
 * injects only its own policy here: how to resolve the destination, which config
 * key (bucket + filename prefix) to use, and what counts as a real submission.
 *
 * Banking is the first recipe (safest — a STABLE account-folder id, no
 * mutable-name Leads hazard). Others are added one at a time as they ship.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { collectUploadPaths } from "@/lib/portal/wizard-uploads"

/** Everything the archival engine needs to write ONE submission's package. Either
 *  derived fresh by a recipe's resolvePlan(), or read back from the values PINNED
 *  into drive_archive_meta at submission time (so deferred archival never
 *  re-derives a folder from a mutable name / re-guesses the bucket). */
export interface ArchivePlan {
  /** Drive folder id the package lands in (a stable id, never a name). */
  folderId: string
  /** Supabase Storage bucket the uploaded files actually live in. */
  bucket: string
  /** saveFormToDrive form-config key (drives the filename prefix + subfolder). */
  configKey: string
  /** Storage paths of the client's uploaded files. */
  uploadPaths: string[]
  /** For the accountant-PDF filename slug. */
  companyName?: string
}

export interface ArchiveRecipe {
  /** Registry key + job-payload discriminator (e.g. "banking"). */
  formType: string
  /** Submission table this form's rows live in. */
  table: string
  /** Columns the engine + sweep select for a row of this table. */
  selectColumns: string
  /** True for a genuinely-submitted row (not an empty pending/draft shell). */
  isReal(row: Record<string, unknown>): boolean
  /**
   * Resolve the full archive plan for a row. MUST throw on a retryable read
   * error (so the job retries) AND throw loudly on a genuinely-absent
   * destination (so the sweep alerts) — NEVER return a silent fallback that
   * misfiles. Called on the no-pin (sweep/backstop) path; the fire path pins the
   * plan at submission and the engine skips this.
   */
  resolvePlan(row: Record<string, unknown>): Promise<ArchivePlan>
}

/** Read an account's stable Drive folder id. Throws retryable on a read error,
 *  loud on a genuinely-absent folder — the exact distinction the Carasso incident
 *  turned on (a swallowed read error read as "no folder" → silent skip). */
async function resolveAccountFolder(accountId: string): Promise<{ folderId: string; companyName?: string }> {
  const { data: acc, error } = await supabaseAdmin
    .from("accounts")
    .select("drive_folder_id, company_name")
    .eq("id", accountId)
    .maybeSingle()
  if (error) throw new Error(`archive: account read failed (retryable): ${error.message}`)
  if (!acc) throw new Error(`archive: account ${accountId} not found`)
  if (!acc.drive_folder_id) {
    throw new Error(`archive: account ${accountId} (${acc.company_name ?? "?"}) has NO drive_folder_id — needs a Drive folder before its package can be archived`)
  }
  return { folderId: acc.drive_folder_id, companyName: acc.company_name ?? undefined }
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).filter((p): p is string => typeof p === "string") : []
}

/**
 * Infer the saveFormToDrive config key + storage bucket for a banking row from its
 * provider (the no-pin / sweep fallback). Pure — the fire path pins the exact plan.
 *  - "relay" → portal-wizard Relay:  config banking_relay,  bucket onboarding-uploads
 *  - "payset" → portal-wizard Payset: config banking_payset, bucket onboarding-uploads
 *  - anything else (external form)   → config banking,       bucket banking-uploads
 */
export function bankingConfigAndBucket(provider: string | null | undefined): { configKey: string; bucket: string } {
  if (provider === "relay") return { configKey: "banking_relay", bucket: "onboarding-uploads" }
  if (provider === "payset") return { configKey: "banking_payset", bucket: "onboarding-uploads" }
  return { configKey: "banking", bucket: "banking-uploads" }
}

/**
 * The client's uploaded file paths for a submission, from BOTH sources, deduped:
 *  - the upload_paths COLUMN (populated by external public forms), and
 *  - paths embedded INSIDE submitted_data (the only place portal-wizard banking
 *    rows keep them — the wizard never writes the column).
 * Reading the column alone silently loses every wizard submission's files
 * (bug-hunter blocker, 2026-07-24). Pure so it's unit-testable without the DB.
 */
export function deriveUploadPaths(columnPaths: unknown, submittedData: Record<string, unknown> | null | undefined): string[] {
  const fromColumn = asStringArray(columnPaths)
  const fromData = collectUploadPaths((submittedData ?? {}) as Record<string, unknown>)
  return Array.from(new Set([...fromColumn, ...fromData]))
}

/**
 * BANKING recipe. Two submission origins share one table:
 *  - external banking form → bucket "banking-uploads",  config "banking"
 *  - portal wizard         → bucket "onboarding-uploads", config "banking_payset|banking_relay"
 * The fire path pins the exact plan; this fallback (sweep / un-pinned) infers the
 * config from the row's provider. Folder is ALWAYS the account's company folder —
 * banking is post-formation, so a completed row with no account folder is a loud
 * anomaly, not a silent skip.
 */
const bankingRecipe: ArchiveRecipe = {
  formType: "banking",
  table: "banking_submissions",
  selectColumns:
    "id, account_id, token, provider, status, submitted_data, upload_paths, completed_at, created_at, drive_archived_at, drive_archive_meta",
  isReal(row) {
    const status = row.status as string | null
    return status === "completed" || status === "reviewed"
  },
  async resolvePlan(row) {
    const accountId = row.account_id as string | null
    if (!accountId) {
      throw new Error(`archive: banking submission ${row.id} is completed but has no account_id — cannot resolve a company Drive folder`)
    }
    const { folderId, companyName } = await resolveAccountFolder(accountId)
    const { configKey, bucket } = bankingConfigAndBucket(row.provider as string | null)
    // CRITICAL (bug-hunter blocker, 2026-07-24): the portal-wizard banking rows
    // (payset/relay) NEVER persist the upload_paths COLUMN — the client's file
    // paths live only inside submitted_data. Reading the column alone would
    // archive an empty package (summary only) and set the marker, silently losing
    // the client's KYC uploads. So on the no-pin fallback path we UNION the column
    // with the paths extracted from submitted_data (the same extractor the wizard
    // itself uses), covering BOTH origins: external form (column) and wizard (data).
    const uploadPaths = deriveUploadPaths(row.upload_paths, row.submitted_data as Record<string, unknown> | null)
    return { folderId, bucket, configKey, uploadPaths, companyName }
  },
}

/** All registered form recipes, keyed by formType. Add a form here (+ its marker
 *  columns migration + enqueue wiring) when it adopts the durable archival. */
export const ARCHIVE_RECIPES: Record<string, ArchiveRecipe> = {
  banking: bankingRecipe,
}

export function getArchiveRecipe(formType: string): ArchiveRecipe | null {
  return ARCHIVE_RECIPES[formType] ?? null
}
