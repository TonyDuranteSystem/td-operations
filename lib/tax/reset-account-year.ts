/**
 * Reset an account-year's BANK STATEMENT DATA ONLY — card 4a39e0fd, the
 * Dynamiq-class accounts (statements re-ingested from multiple overlapping
 * sources, correct source files identified in Drive, database needs a clean
 * slate to load them into). Antonio's scope, verbatim: "clean all bank
 * statement uploaded and start over... without touching the questionnaire."
 *
 * Touches ONLY: `bank_transactions` rows for the account+year; the
 * `bank_accounts_N_statements` file-path arrays AND the legacy singular
 * `bank_statements` field (old in-flight drafts can still carry it — see
 * `wizard-configs.ts`) inside the submission's `submitted_data`;
 * `financials_meta.coverage_answers` and `.ready_notified`, both of which
 * describe or gate messaging about the data this function just erased and
 * would otherwise silently misdescribe the fresh upload; and the client's
 * attestation (via `resetFinancialsAttestation`, see below). Every other
 * wizard answer (company info, members, compliance questions, which banks
 * the client uses) is untouched — those live in the SAME JSON object as
 * separate keys.
 *
 * THIRD bug-hunter pass found one more blocker, fixed here: cancelling a
 * job_queue row's STATUS cannot stop a worker function that already claimed
 * it and is actively executing — a genuinely in-flight `processing` job
 * (most dangerously `tax_form_setup`, per round 2) keeps running regardless,
 * reaches its own re-enqueue step using its FROZEN pre-reset payload, and
 * silently resurrects the data this function just deleted, with the CLI
 * having already printed success and exited. The fix is a pre-flight
 * REFUSAL, not a cancellation — matching the sibling `deleteStatementRows`,
 * which deliberately excludes `processing` from what it cancels with the
 * comment "a running handler can't be stopped safely." `dryRun:false`
 * throws before touching anything if any job_queue row for this
 * account+year is currently `processing`; the caller must wait for it to
 * finish (or resolve it manually) and retry.
 *
 * SECOND bug-hunter pass (Antonio-requested, after the first round's fixes
 * below were already applied) found three further blockers, all fixed here:
 *
 * 1. Cancels EVERY job_queue row for this account+year, any job_type — not
 *    only `ingest_bank_statement`. A stuck/retried `tax_form_setup` row
 *    (the exact failure class this codebase already named Dynamiq for once
 *    — see `statement-ingest-enqueue.ts`'s own header) re-enqueues ingest
 *    jobs from its FROZEN pre-reset `upload_paths`, silently re-inserting
 *    the deleted data. Filtering by `payload->>tax_year` alone (no
 *    `job_type` filter) is safe: a job whose payload has no `tax_year` key
 *    simply never matches the equality check, so unrelated job types
 *    (welcome-package emails, invoice reminders, etc.) are never touched.
 * 2. Calls `resetFinancialsAttestation` — without it, a client who already
 *    confirmed the OLD (duplicated/wrong) numbers keeps `confirmation_
 *    accepted=true` after the reset, which both advances the Service
 *    Delivery stage as if data collection is done over zero transactions
 *    AND makes the categorization-refresh sweep treat the account as
 *    hands-off, permanently skipping the freshly re-ingested rows. Any
 *    staff `failed_files_override` unlock is invalidated the same way, for
 *    the same reason it already is on every ordinary file delete/upload.
 * 3. `ready_notified` is cleared alongside `coverage_answers` — otherwise
 *    the "your P&L is ready to review" notification is permanently
 *    suppressed the next time ingestion completes, since that check is a
 *    simple already-notified boolean with no other trigger.
 *
 * ARCHIVE BEFORE DELETE, NEVER DESTROY (Antonio's standing rule for this
 * class of repair). `dryRun: true` (the default) computes and returns the
 * full plan — including every row that WOULD be deleted — without writing
 * anything. THIS FUNCTION DOES NOT PERSIST THE ARCHIVE ITSELF — the caller
 * MUST write `archivedTransactions` somewhere durable and confirm the write
 * before ever calling again with `dryRun: false`; second bug-hunter pass:
 * this is not currently enforced by any code path, only by this sentence —
 * whoever builds the runner that actually invokes this against a real
 * account must make the persist-and-verify step structural, not assumed.
 * The archive read is PAGED (`fetchAllPaged`, the same driver
 * `fetchAllBankTransactionsByYear` uses) — first bug-hunter pass: an
 * earlier cut used one unbounded `select()`, which PostgREST caps at 1000
 * rows; Dynamiq alone carries roughly 10x that, so that version would have
 * archived a tenth of the account while the (uncapped) delete removed all
 * of it — reproducing the exact incident `bank-transactions-fetch.ts` was
 * built to close, on the same account.
 */

import { resolveClientSubmission } from "./resolve-submission"
import { fetchAllPaged, BANK_TX_PAGE_SIZE } from "../bank-transactions-fetch"
import { resetFinancialsAttestation } from "./attestation"

const STATEMENT_KEY = /^bank_accounts_\d+_statements$/
/** Old in-flight drafts can still carry the pre-repeater singular field. */
const LEGACY_STATEMENT_KEY = "bank_statements"

/** Every statement-file-list key present in a submission's data — the
 *  indexed `bank_accounts_N_statements` shape and the legacy singular one. */
export function statementFileKeys(submittedData: Record<string, unknown>): string[] {
  const keys = Object.keys(submittedData).filter(k => STATEMENT_KEY.test(k))
  if (LEGACY_STATEMENT_KEY in submittedData) keys.push(LEGACY_STATEMENT_KEY)
  return keys
}

/**
 * `submittedData` with every statement-file-list key reset to empty and
 * every other key byte-identical. Pure — never mutates the input.
 */
export function clearedSubmittedData(submittedData: Record<string, unknown>): Record<string, unknown> {
  const next = { ...submittedData }
  for (const key of statementFileKeys(submittedData)) next[key] = []
  return next
}

export interface BankTransactionRow {
  id: string
  [col: string]: unknown
}

export interface AccountYearResetPlan {
  accountId: string
  taxYear: number
  submissionId: string | null
  /** Full rows that would be / were deleted — THE archive. Persist this before dryRun:false. */
  archivedTransactions: BankTransactionRow[]
  archivedCount: number
  /** Statement-list keys that would be / were cleared in submitted_data. */
  clearedStatementKeys: string[]
  /** Whether financials_meta.coverage_answers had a value that would be / was cleared. */
  hadCoverageAnswers: boolean
  /** Whether financials_meta.ready_notified was true (would be / was cleared). */
  hadReadyNotified: boolean
  /** job_queue rows (any job_type) for this account+year that would be / were
   *  cancelled — a count here does not appear until dryRun:false (the row
   *  set can shift between the dry run and the apply call). */
  cancelledJobCount: number
  /** A job_queue row for this account+year is CURRENTLY `processing` — third
   *  bug-hunter pass: apply refuses to run while this is true (see header). */
  hasProcessingJob: boolean
  /** Set only if resetFinancialsAttestation's write failed — attestation may
   *  still be standing over the now-deleted data. Absent on a clean apply. */
  attestationError?: string
  applied: boolean
}

/** job_queue statuses whose rows would block a future re-upload of the same
 *  path via the "already queued" idempotency check, OR could re-run and
 *  re-insert stale data if reaped/retried after the reset — every status
 *  except an already-cancelled row. Applied across ALL job_type values (see
 *  header) — a stuck tax_form_setup row is exactly as dangerous here as a
 *  stuck ingest_bank_statement row. */
const BLOCKING_JOB_STATUSES = ["pending", "processing", "completed", "failed"] as const

/**
 * Compute (dryRun:true, default) or execute (dryRun:false) the reset.
 *
 * `db` is a supabase client. Uses the canonical `resolveClientSubmission` —
 * never a second hand-rolled submission query (the standing lesson in this
 * codebase: a fresh `.from().select().eq()` against a shape you remember is
 * how these readers die — see resolve-submission.ts's own history).
 */
export async function resetAccountYearBankStatements(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  accountId: string,
  taxYear: number,
  opts: { dryRun?: boolean } = {},
): Promise<AccountYearResetPlan> {
  const dryRun = opts.dryRun ?? true

  const submission = await resolveClientSubmission<{
    id: string
    submitted_data: Record<string, unknown>
    financials_meta: Record<string, unknown> | null
  }>(db, accountId, taxYear, "id, submitted_data, financials_meta")

  const archivedTransactions: BankTransactionRow[] = await fetchAllPaged<BankTransactionRow>(
    async (from, to) => {
      const { data, error } = await db
        .from("bank_transactions")
        .select("*")
        .eq("account_id", accountId)
        .eq("tax_year", taxYear)
        .order("id", { ascending: true })
        .range(from, to)
      if (error) throw new Error(`Could not read existing transactions: ${error.message}`)
      return (data ?? []) as BankTransactionRow[]
    },
    BANK_TX_PAGE_SIZE,
  )
  const submittedData = submission?.submitted_data ?? {}
  const clearedStatementKeys = statementFileKeys(submittedData)
  const financialsMeta = submission?.financials_meta ?? {}
  const hadCoverageAnswers = Boolean(
    financialsMeta && typeof financialsMeta === "object" &&
    financialsMeta["coverage_answers"] &&
    Object.keys(financialsMeta["coverage_answers"] as object).length > 0,
  )
  const hadReadyNotified = Boolean(financialsMeta && typeof financialsMeta === "object" && financialsMeta["ready_notified"] === true)

  // Third bug-hunter pass: check for an ACTIVELY EXECUTING job before doing
  // anything. Computed in both dry-run and apply so a dry-run preview
  // already warns about it — but only apply mode refuses on it (below).
  const { count: processingJobCount, error: processingCheckError } = await db
    .from("job_queue")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("payload->>tax_year", String(taxYear))
    .eq("status", "processing")
  if (processingCheckError) throw new Error(`Could not check for in-flight jobs: ${processingCheckError.message}`)
  const hasProcessingJob = (processingJobCount ?? 0) > 0

  const plan: AccountYearResetPlan = {
    accountId,
    taxYear,
    submissionId: submission?.id ?? null,
    archivedTransactions,
    archivedCount: archivedTransactions.length,
    clearedStatementKeys,
    hadCoverageAnswers,
    hadReadyNotified,
    cancelledJobCount: 0,
    hasProcessingJob,
    applied: false,
  }

  if (dryRun) return plan

  // Cancelling a job_queue row's STATUS cannot stop a worker function that
  // already claimed it and is actively running — it will finish regardless
  // and (for tax_form_setup especially) can re-enqueue ingest jobs from its
  // frozen pre-reset payload, resurrecting the data this call is about to
  // delete, invisibly, after this function has already returned success.
  // REFUSE rather than proceed; the caller retries once the job clears.
  if (hasProcessingJob) {
    throw new Error(
      `Refusing to apply: a job_queue row for account ${accountId}, tax year ${taxYear} is currently 'processing'. ` +
      `Wait for it to finish (or investigate/resolve it manually) and retry — applying now risks the reset being silently undone.`,
    )
  }

  if (archivedTransactions.length > 0) {
    const { error: deleteError } = await db
      .from("bank_transactions")
      .delete()
      .eq("account_id", accountId)
      .eq("tax_year", taxYear)
    if (deleteError) throw new Error(`Delete failed: ${deleteError.message}`)
  }

  // Cancel every job_queue row for this account+year, ANY job_type — second
  // bug-hunter pass: a stuck/retried tax_form_setup row re-enqueues ingest
  // jobs from its FROZEN pre-reset upload_paths, silently re-inserting the
  // data this function just deleted. No job_type filter is needed for
  // safety: a job whose payload has no tax_year key never matches the
  // equality check below, so unrelated job types are never touched.
  // `tax_year` lives in the job payload, not a column.
  const { data: cancelledJobs, error: jobCancelError } = await db
    .from("job_queue")
    .update({ status: "cancelled", error: `Cleared: account-year reset (${new Date().toISOString().slice(0, 10)})` })
    .eq("account_id", accountId)
    .eq("payload->>tax_year", String(taxYear))
    .in("status", BLOCKING_JOB_STATUSES as unknown as string[])
    .select("id")
  if (jobCancelError) throw new Error(`Job cancel failed: ${jobCancelError.message}`)
  const cancelledJobCount = (cancelledJobs ?? []).length

  if (submission?.id) {
    const nextData = clearedSubmittedData(submittedData)
    const nextMeta = { ...financialsMeta }
    if (hadCoverageAnswers) nextMeta["coverage_answers"] = {}
    if (hadReadyNotified) nextMeta["ready_notified"] = false
    const { error: updateError } = await db
      .from("tax_return_submissions")
      .update({ submitted_data: nextData, financials_meta: nextMeta })
      .eq("id", submission.id)
    if (updateError) throw new Error(`Submission update failed: ${updateError.message}`)
  }

  // Second bug-hunter pass: a client attestation (or staff failed-files
  // unlock) made over the data this function just erased must not survive
  // it — reuses the existing, already-proven mechanism rather than
  // reimplementing it. Runs LAST, after the data itself is settled.
  // Third bug-hunter pass: its result used to be discarded — a failed write
  // here left stale attestation standing while the caller still saw
  // `applied: true` with nothing to contradict it. Now checked and thrown,
  // consistent with every other mutation in this function.
  const attestationResult = await resetFinancialsAttestation(accountId, taxYear, "account-year reset")
  if (attestationResult.error) {
    throw new Error(
      `Data was deleted and cleared, but the attestation reset FAILED: ${attestationResult.error}. ` +
      `A stale client confirmation or staff override may still be standing over now-deleted data — check ` +
      `tax_return_submissions.confirmation_accepted / financials_meta.failed_files_override for account ${accountId}, year ${taxYear} by hand.`,
    )
  }

  return { ...plan, cancelledJobCount, applied: true }
}
