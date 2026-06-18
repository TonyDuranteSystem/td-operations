/**
 * Builds the row written to a `*_submissions` table by the portal
 * wizard-submit route (app/api/portal/wizard-submit/route.ts).
 *
 * WHY THIS EXISTS — the submission tables do NOT share one column set:
 *   - formation_submissions has NO account_id (a formation is bought by the
 *     contact before any company/account exists — it carries lead_id instead)
 *   - tax_return_submissions has NO lead_id
 *   - itin_submissions / closure_submissions have NO entity_type
 *   - only tax_return_submissions has tax_year
 *
 * Sending a column a table doesn't have makes the upsert fail with PostgREST
 * error 42703 / PGRST204 → the route returns 500 → the client sees a false
 * "submission failed" toast even though wizard_progress was already saved, and
 * (worse) the failure happens before the auto-chain enqueue, so the background
 * job never runs. This has bitten twice: entity_type on itin/closure (silent
 * ITIN drop, 2026-04) and account_id on formation (false fail, 2026-06).
 *
 * Centralizing the per-table column rules here — and cross-checking the columns
 * this can emit against the generated DB types in a build-time test
 * (tests/unit/submission-record.test.ts) — turns the next drift into a loud CI
 * failure instead of a production 500. Every column-membership fact below was
 * verified against information_schema (prod + sandbox) on 2026-06-18.
 */

/** Tables that HAVE an `entity_type` column. itin/closure do not. */
export const TABLES_WITH_ENTITY_TYPE = new Set([
  "formation_submissions",
  "onboarding_submissions",
  "tax_return_submissions",
  "company_info_submissions",
])

/** Tables that do NOT have a `lead_id` column. */
export const TABLES_WITHOUT_LEAD_ID = new Set(["tax_return_submissions"])

/** Tables that do NOT have an `account_id` column. */
export const TABLES_WITHOUT_ACCOUNT_ID = new Set(["formation_submissions"])

/** Tables that HAVE a `tax_year` column. */
export const TABLES_WITH_TAX_YEAR = new Set(["tax_return_submissions"])

export interface SubmissionRecordInput {
  token: string | null
  contact_id: string | null
  account_id: string | null
  lead_id: string | null
  /** Falls back to 'SMLLC' on tables that carry entity_type. */
  entity_type: string | null
  submitted_data: unknown
  upload_paths: string[]
  /** Only emitted on tables that have the column AND when non-null. */
  tax_year: number | null
}

/**
 * Build the submission upsert record for `table`, including only the columns
 * that table actually has. Required columns (token, contact_id, language,
 * prefilled_data, submitted_data, changed_fields, upload_paths, status) are
 * always present; the varying columns are gated per-table so the builder is
 * correct regardless of what the caller passes.
 */
export function buildSubmissionRecord(
  table: string,
  input: SubmissionRecordInput,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    token: input.token,
    contact_id: input.contact_id || null,
    language: "en",
    prefilled_data: {},
    submitted_data: input.submitted_data,
    changed_fields: {},
    upload_paths: input.upload_paths,
    status: "completed",
  }

  if (TABLES_WITH_ENTITY_TYPE.has(table)) {
    record.entity_type = input.entity_type || "SMLLC"
  }
  if (!TABLES_WITHOUT_LEAD_ID.has(table)) {
    record.lead_id = input.lead_id || null
  }
  if (!TABLES_WITHOUT_ACCOUNT_ID.has(table)) {
    record.account_id = input.account_id || null
  }
  if (TABLES_WITH_TAX_YEAR.has(table) && input.tax_year !== null) {
    record.tax_year = input.tax_year
  }

  return record
}
