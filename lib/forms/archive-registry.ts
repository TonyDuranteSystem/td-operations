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
import { collectUploadPaths, isWizardUploadPath } from "@/lib/portal/wizard-uploads"
import { resolveItinContactFolder, resolveItinClientName } from "@/lib/forms/itin-contact-folder"
import { resolveClosureFolder, resolveClosureClientName } from "@/lib/forms/closure-folder"
import { memberAwareFileName, splitMemberPassports } from "@/lib/forms/file-form-package"

/** Everything the archival engine needs to write ONE submission's package. Either
 *  derived fresh by a recipe's resolvePlan(), or read back from the values PINNED
 *  into drive_archive_meta at submission time (so deferred archival never
 *  re-derives a folder from a mutable name / re-guesses the bucket). */
export interface ArchivePlan {
  /** Drive folder id the package lands in (a stable id, never a name). null = file it by company (the company's storage). */
  folderId: string | null
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
  /** OPTIONAL: the sweep never touches rows created before this (a form that joined the sweep later: older rows were filed the old way). */
  sweepNotBefore?: string
  /** OPTIONAL: the name each stored upload gets (formation: the member's name on each passport). */
  fileNameOf?(row: Record<string, unknown>): ((path: string) => string) | undefined
  /**
   * OPTIONAL per-file bucket resolver, for a form whose files can live in MORE
   * THAN ONE storage bucket (e.g. closure: external form → closure-uploads, portal
   * wizard → onboarding-uploads). Applied per upload path so both origins download
   * from the right bucket. Omit for single-origin forms (they use plan.bucket).
   * A pure function (not part of the pinned plan) so it survives the JSON pin.
   */
  resolveBucket?: (path: string) => string
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
    "id, account_id, contact_id, token, provider, status, submitted_data, upload_paths, completed_at, created_at, drive_archived_at, drive_archive_meta",
  isReal(row) {
    const status = row.status as string | null
    return status === "completed" || status === "reviewed"
  },
  async resolvePlan(row) {
    const accountId = row.account_id as string | null
    if (!accountId) {
      throw new Error(`archive: banking submission ${row.id} is completed but has no account_id — cannot resolve a company Drive folder`)
    }
    // Stop Drive (dev job 264bb882, S1d): the company's STORAGE (or its Drive folder if it was left on Drive) — a company in storage
    // with no Drive folder used to make this throw "NO drive_folder_id" on every sweep, so a row whose pin was never written could never heal.
    const { formDestinationForAccount } = await import("@/lib/crm-store/form-destination")
    const dest = await formDestinationForAccount(accountId, "banking-archive")
    if (!dest.ok) throw new Error(`archive: banking submission ${row.id} has nowhere to be filed — ${dest.sentence}`)
    const folderId = dest.folderId
    const { data: acctRow, error: acctErr } = await supabaseAdmin.from("accounts").select("company_name").eq("id", accountId).maybeSingle()
    if (acctErr) throw new Error(`archive: account read failed (retryable): ${acctErr.message}`)
    const companyName = (acctRow?.company_name as string | null | undefined) ?? undefined
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

/**
 * ITIN recipe. Person-keyed — files under the CONTACT, never the company's main
 * area: a company-owner's ITIN goes in the company's "2. Contacts" subfolder; an
 * individual's goes under "Individual Clients" (see resolveItinContactFolder).
 * Single submission table, single storage bucket (onboarding-uploads). The fire
 * path pins the resolved folder; this fallback re-resolves it identically.
 */
const itinRecipe: ArchiveRecipe = {
  formType: "itin",
  table: "itin_submissions",
  selectColumns:
    "id, token, lead_id, account_id, contact_id, status, submitted_data, upload_paths, completed_at, created_at, drive_archived_at, drive_archive_meta",
  isReal(row) {
    return (row.status as string | null) === "completed"
  },
  async resolvePlan(row) {
    const leadId = (row.lead_id as string | null) ?? null
    const contactId = (row.contact_id as string | null) ?? null
    const token = (row.token as string | null) ?? null
    const clientName = await resolveItinClientName({ leadId, contactId, token })
    const { contactForSubmissionRow } = await import("@/lib/crm-store/lead-form-store")
    const folderId = await resolveItinContactFolder({
      accountId: (row.account_id as string | null) ?? null,
      contactId: await contactForSubmissionRow(row, "archive:itin"),
      leadId,
      token,
      clientName,
    })
    return {
      folderId,
      bucket: "onboarding-uploads",
      configKey: "itin",
      uploadPaths: deriveUploadPaths(row.upload_paths, row.submitted_data as Record<string, unknown> | null),
      companyName: clientName || undefined,
    }
  },
}

/**
 * CLOSURE recipe. Files where the completion route files today, made reliable:
 * the company folder when an account is explicitly linked (never inferred from a
 * contact link — a person may own several companies), else the client's storage
 * (no Drive "Leads" folder is created any more). The external closure form
 * uploads to the "closure-uploads" bucket. This durable path BACKSTOPS the
 * best-effort completion save (retry + marker); the separate review/MCP re-saves
 * to the company folder are unchanged.
 */
const closureRecipe: ArchiveRecipe = {
  formType: "closure",
  table: "closure_submissions",
  selectColumns:
    "id, token, account_id, contact_id, lead_id, status, submitted_data, upload_paths, completed_at, created_at, drive_archived_at, drive_archive_meta",
  isReal(row) {
    const status = row.status as string | null
    return status === "completed" || status === "reviewed"
  },
  // Closure has TWO upload origins: the external form (closure-uploads) and the
  // portal wizard (onboarding-uploads, "closure/"-prefixed paths). Resolve the
  // bucket PER PATH so both archive correctly — a single default would silently
  // lose the other origin's files.
  resolveBucket(path) {
    return isWizardUploadPath(path) ? "onboarding-uploads" : "closure-uploads"
  },
  async resolvePlan(row) {
    const submittedData = (row.submitted_data ?? {}) as Record<string, unknown>
    const clientName = await resolveClosureClientName({
      submittedData,
      leadId: (row.lead_id as string | null) ?? null,
      contactId: (row.contact_id as string | null) ?? null,
      token: (row.token as string | null) ?? null,
    })
    const llcName = String(submittedData.llc_name || "Unknown LLC")
    const folderId = await resolveClosureFolder({
      accountId: (row.account_id as string | null) ?? null,
      contactId: (row.contact_id as string | null) ?? null,
      clientName,
    })
    return {
      folderId,
      bucket: "closure-uploads",
      configKey: "closure",
      uploadPaths: deriveUploadPaths(row.upload_paths, submittedData),
      companyName: llcName,
    }
  },
}

/**
 * FORMATION recipe (Stop-Drive S1a). The lead-stage formation form files its summary + uploads in the person's storage
 * (person-storage:<contactId>, opened on first use). The contact is the submission's own, else the lead's by exact email + name;
 * undecided = a loud, counted failure (the sweep alerts at the limit) — never a Drive folder, never a guessed person.
 */
const formationRecipe: ArchiveRecipe = {
  formType: "formation",
  sweepNotBefore: "2026-10-19T00:00:00Z",
  table: "formation_submissions",
  selectColumns: "id, token, lead_id, contact_id, status, submitted_data, upload_paths, completed_at, created_at, drive_archived_at, drive_archive_meta",
  isReal(row) {
    return (row.status as string | null) === "completed"
  },
  async resolvePlan(row) {
    const { contactForSubmissionRow, storageDestinationForForm } = await import("@/lib/crm-store/lead-form-store")
    const contactId = await contactForSubmissionRow(row, "archive:formation")
    if (!contactId) throw new Error(`archive: formation ${row.id} — no single contact could be decided for this lead; nothing was filed`)
    const dest = await storageDestinationForForm({ contactId })
    if (!dest.marker) throw new Error(`archive: formation ${row.id} — this person only has a hidden study-copy storage; staff decide where it goes`)
    const data = (row.submitted_data ?? {}) as Record<string, unknown>
    const { data: lead } = row.lead_id ? await supabaseAdmin.from("leads").select("full_name").eq("id", row.lead_id as string).maybeSingle() : { data: null }
    return { folderId: dest.marker, bucket: "onboarding-uploads", configKey: "formation", uploadPaths: splitMemberPassports(deriveUploadPaths(row.upload_paths, data)).forPrimary, companyName: lead?.full_name || undefined }
  },
  fileNameOf(row) {
    return memberAwareFileName((row.submitted_data ?? {}) as Record<string, unknown>)
  },
}

/**
 * ONBOARDING recipe (Stop-Drive S1a). An onboarding lead has no contact until staff review it, so a submission only becomes
 * "real" for filing once review has linked a company or a contact (account_id / contact_id) — before that the uploads stay with the
 * submission and nothing is retried or alerted. Then: the company's storage if it has one, else the person's.
 */
const onboardingRecipe: ArchiveRecipe = {
  formType: "onboarding",
  sweepNotBefore: "2026-10-19T00:00:00Z",
  table: "onboarding_submissions",
  selectColumns: "id, token, lead_id, account_id, contact_id, status, submitted_data, upload_paths, completed_at, created_at, drive_archived_at, drive_archive_meta",
  isReal(row) {
    // a lead with no contact yet has nothing to file under (the review's setup job files the company documents later)
    return (row.status as string | null) === "completed" && !!row.contact_id
  },
  async resolvePlan(row) {
    const { storageDestinationForForm } = await import("@/lib/crm-store/lead-form-store")
    // PERSON only — never the company's folders: an onboarding package holds passports / IDs, which are personal documents.
    // The company's own documents reach the company through the review's setup job. One copy, one place.
    const dest = await storageDestinationForForm({ contactId: (row.contact_id as string | null) ?? null })
    if (!dest.marker) throw new Error(`archive: onboarding ${row.id} — no contact to file under, or only a hidden study-copy storage; staff decide where it goes`)
    const data = (row.submitted_data ?? {}) as Record<string, unknown>
    const { data: lead } = row.lead_id ? await supabaseAdmin.from("leads").select("full_name").eq("id", row.lead_id as string).maybeSingle() : { data: null }
    return { folderId: dest.marker, bucket: "onboarding-uploads", configKey: "onboarding", uploadPaths: deriveUploadPaths(row.upload_paths, data), companyName: lead?.full_name || undefined }
  },
}

/** All registered form recipes, keyed by formType. Add a form here (+ its marker
 *  columns migration + enqueue wiring) when it adopts the durable archival. */
export const ARCHIVE_RECIPES: Record<string, ArchiveRecipe> = {
  banking: bankingRecipe,
  itin: itinRecipe,
  closure: closureRecipe,
  formation: formationRecipe,
  onboarding: onboardingRecipe,
}

export function getArchiveRecipe(formType: string): ArchiveRecipe | null {
  return ARCHIVE_RECIPES[formType] ?? null
}
