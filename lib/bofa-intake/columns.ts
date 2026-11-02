/**
 * Bank application intake — the column lists the staff routes read. The review columns arrived with the migration
 * 20261102-1900; until Antonio has run it on a database they do not exist there, and a SELECT naming a missing column fails
 * as a whole. So every staff read tries the full list first and, if the database refuses it, falls back to the long-standing
 * list and reports `reviewReady: false` — the page then shows the applications but keeps Reviewed / Submit / Send back
 * switched off, instead of the whole page going dark.
 */

/** Always present (the long-standing columns). */
export const LIST_COLUMNS =
  "id, token, label, partner_name, recipients, email_status, email_sent_at, email_error, status, opened_at, completed_at, created_at, updated_at, created_by, notified_at, store_owner_id, store_folder_id, store_archived_at, store_error, client_name:form_data->>full_name, client_company:form_data->>company_name"

export const DETAIL_COLUMNS =
  "id, label, partner_name, recipients, email_status, email_sent_at, email_error, status, opened_at, completed_at, created_at, updated_at, created_by, form_data, files, notified_at, store_owner_id, store_folder_id, store_archived_at, store_error"

/** Added by the review-gate migration. */
export const REVIEW_COLUMNS = "reviewed_at, reviewed_by, sent_by, sent_to, returned_at, returned_by, return_note, replaces_id, staff_note"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a Supabase query builder over a table that is not in the generated types
type Runner<T> = (columns: string) => PromiseLike<{ data: T | null; error: { message: string } | null }>

/** Run a read with the review columns; if the database refuses (column missing), run it again without them. */
export async function readWithReviewColumns<T>(base: string, run: Runner<T>): Promise<{ data: T | null; error: { message: string } | null; reviewReady: boolean }> {
  const full = await run(`${base}, ${REVIEW_COLUMNS}`)
  if (!full.error) return { ...full, reviewReady: true }
  const legacy = await run(base)
  return { ...legacy, reviewReady: false }
}
