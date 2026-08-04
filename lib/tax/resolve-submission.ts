/**
 * WHICH submission row is "the client's tax file" for an account + year.
 *
 * ONE resolver, used by every tax-financials surface — the page payload, the
 * lock check on every write route, the coverage answers, the prior-return
 * answer, and the attestation. Before this existed there were TWO competing
 * rules and both were wrong in a different way:
 *
 *  A. `.eq('status','completed')` — used by the coverage route, the attestation
 *     write, the prior-return route and the page's own read. It MISSES
 *     `status='reviewed'`, which is what a submission becomes once staff run
 *     apply-changes. Live consequence (found 2026-08-03): ALL FIVE accounts in
 *     the review loop carry `reviewed`, so every coverage answer and every
 *     attempt to confirm 404'd with "No submission found for this year" — the
 *     client's answers were silently never stored and Confirm could never
 *     unlock. Bence Koncz (Imperium) sat on exactly that: two coverage
 *     questions that looked unanswered because they could not be saved.
 *     Production at the time: 47 of 79 account-years for 2025 had no
 *     `completed` row at all.
 *
 *  B. "newest row, ANY status" — used by the eight write routes' lock check.
 *     `pending` / `opened` rows are forms that were SENT and never filled
 *     (verified: 17 such rows, ZERO with submitted_data), and one of them
 *     arriving later than the real submission would read as `review_status =
 *     null` and unlock a file that is under review or already confirmed.
 *
 * The rule here is the intersection of what both were reaching for: the NEWEST
 * row that actually holds client data. `completed` and `reviewed` are exactly
 * those (verified in production: 33 completed + 44 reviewed, every one with
 * data; 6 of the `reviewed` rows are already attested, which is why `reviewed`
 * must count as a real file and not a lesser state).
 *
 * Using it for BOTH the lock read and the write read on the same request also
 * closes the split where a route could evaluate the lock on one row and write
 * to another.
 */

/** Statuses whose rows carry real client answers. Everything else is an unfilled form. */
export const SUBMISSION_DATA_STATUSES = ["completed", "reviewed"] as const

/**
 * Newest submission holding client data for this account + year, or null.
 *
 * `db` is a supabase client (typed or the loose cast some routes use, since
 * `financials_meta` is not in the generated types). `select` is the column list
 * the caller needs — the caller owns its own projection.
 */
export async function resolveClientSubmission<T = Record<string, unknown>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  accountId: string,
  taxYear: number,
  select: string,
): Promise<T | null> {
  const { data } = await db
    .from("tax_return_submissions")
    .select(select)
    .eq("account_id", accountId)
    .eq("tax_year", taxYear)
    .in("status", SUBMISSION_DATA_STATUSES as unknown as string[])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as T) ?? null
}

/**
 * Is the client allowed to change their tax data right now?
 *
 * Returns the resolved status alongside the verdict so a caller can surface it.
 * A file with NO data row yet is editable (nothing to protect); the lock only
 * bites once a real submission exists and staff have taken it (`under_review`)
 * or the client has finished (`confirmed`).
 */
export async function resolveEditability(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  accountId: string,
  taxYear: number,
): Promise<{ editable: boolean; reviewStatus: string | null }> {
  const { isClientEditable } = await import("./review-status")
  const row = await resolveClientSubmission<{ review_status: string | null }>(
    db,
    accountId,
    taxYear,
    "review_status",
  )
  const reviewStatus = row?.review_status ?? null
  return {
    editable: reviewStatus === null || isClientEditable(reviewStatus as never),
    reviewStatus,
  }
}
