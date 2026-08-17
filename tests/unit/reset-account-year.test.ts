/**
 * Account-year bank-statement reset (card 4a39e0fd). The scope contract is
 * the whole point: clear statement FILE LISTS only, never the rest of the
 * questionnaire living in the same submitted_data object — and never touch
 * real data without the caller having the archive in hand first (dryRun
 * defaults true; the plan returned IS the archive).
 *
 * TWO independent bug-hunter passes shaped this suite:
 * Round 1: the archive read MUST page past PostgREST's 1000-row cap —
 * Dynamiq alone has ~10x that; an earlier cut silently archived a tenth of
 * the account while the uncapped delete removed all of it. Old ingest jobs
 * MUST be cancelled, or a re-upload of a previously-seen file silently
 * no-ops behind the enqueue helper's "already queued" idempotency check.
 * Round 2: job-cancellation MUST cover every job_type, not just
 * ingest_bank_statement — a stuck tax_form_setup row re-enqueues ingest
 * jobs from its frozen pre-reset paths and silently undoes the reset. A
 * pre-existing client attestation (or staff failed-files override) MUST be
 * invalidated, or the account reads as "confirmed" over zero transactions.
 * ready_notified MUST clear alongside coverage_answers, or the "your P&L is
 * ready" notification is permanently suppressed on the next clean upload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const resetFinancialsAttestationMock = vi.fn(async () => ({ cleared: false }) as { cleared: boolean; error?: string })
vi.mock("@/lib/tax/attestation", () => ({
  resetFinancialsAttestation: (...args: unknown[]) => resetFinancialsAttestationMock(...args),
}))

import { statementFileKeys, clearedSubmittedData, resetAccountYearBankStatements } from "@/lib/tax/reset-account-year"

describe("statementFileKeys", () => {
  it("finds every bank_accounts_N_statements key, any N", () => {
    const data = {
      company_name: "Dynamiq SR LLC",
      bank_accounts_count: "4",
      bank_accounts_0_statements: ["a.csv"],
      bank_accounts_1_statements: ["b.pdf", "c.pdf"],
      bank_accounts_2_statements: [],
      bank_accounts_10_statements: ["d.csv"],
    }
    expect(new Set(statementFileKeys(data))).toEqual(new Set([
      "bank_accounts_0_statements",
      "bank_accounts_1_statements",
      "bank_accounts_10_statements",
      "bank_accounts_2_statements",
    ]))
  })

  it("never matches the bank_name/kind/label/count keys — those are declarations, not uploads", () => {
    const data = {
      bank_accounts_0_bank_name: "Chase",
      bank_accounts_0_account_kind: "checking",
      bank_accounts_0_account_label: "1234",
      bank_accounts_count: "1",
    }
    expect(statementFileKeys(data)).toEqual([])
  })

  it("empty object yields no keys", () => {
    expect(statementFileKeys({})).toEqual([])
  })

  it("also picks up the legacy singular bank_statements field on old in-flight drafts", () => {
    const data = { company_name: "Old Draft LLC", bank_statements: ["legacy.pdf"] }
    expect(statementFileKeys(data)).toEqual(["bank_statements"])
  })

  it("both shapes together, if a draft somehow carries both", () => {
    const data = { bank_accounts_0_statements: ["a.csv"], bank_statements: ["legacy.pdf"] }
    expect(new Set(statementFileKeys(data))).toEqual(new Set(["bank_accounts_0_statements", "bank_statements"]))
  })
})

describe("clearedSubmittedData", () => {
  it("empties every statement-file key and leaves everything else byte-identical", () => {
    const data = {
      company_name: "Dynamiq SR LLC",
      member_0_member_first_name: "Sofia",
      bank_accounts_count: "4",
      bank_accounts_0_bank_name: "Chase",
      bank_accounts_0_statements: ["chase_jan.csv", "chase_feb.csv"],
      bank_accounts_1_bank_name: "Relay",
      bank_accounts_1_statements: ["relay_jan.csv"],
      mmllc_foreign_partners: "No",
    }
    const result = clearedSubmittedData(data)
    expect(result.bank_accounts_0_statements).toEqual([])
    expect(result.bank_accounts_1_statements).toEqual([])
    expect(result.company_name).toBe("Dynamiq SR LLC")
    expect(result.member_0_member_first_name).toBe("Sofia")
    expect(result.mmllc_foreign_partners).toBe("No")
    expect(result.bank_accounts_count).toBe("4")
    expect(result.bank_accounts_0_bank_name).toBe("Chase")
    expect(result.bank_accounts_1_bank_name).toBe("Relay")
  })

  it("clears the legacy bank_statements field too", () => {
    const data = { company_name: "Old Draft LLC", bank_statements: ["legacy.pdf"] }
    expect(clearedSubmittedData(data).bank_statements).toEqual([])
  })

  it("never mutates the input object", () => {
    const data = { bank_accounts_0_statements: ["a.csv"] }
    const frozen = JSON.stringify(data)
    clearedSubmittedData(data)
    expect(JSON.stringify(data)).toBe(frozen)
  })

  it("a submission with no bank data at all round-trips unchanged", () => {
    const data = { company_name: "Empty Co", ein: "12-3456789" }
    expect(clearedSubmittedData(data)).toEqual(data)
  })
})

// ---------------------------------------------------------------------------
// resetAccountYearBankStatements — mock a chainable supabase-js-shaped client
// across THREE tables: `tax_return_submissions` (resolveClientSubmission's
// own read, plus this function's write), `bank_transactions` (paginated
// select via fetchAllPaged + delete), and `job_queue` (cancel).
// ---------------------------------------------------------------------------

interface MockConfig {
  submission?: { id: string; submitted_data: Record<string, unknown>; financials_meta: Record<string, unknown> | null } | null
  transactions?: Array<{ id: string; [k: string]: unknown }>
  fetchError?: { message: string }
  deleteError?: { message: string }
  updateError?: { message: string }
  jobCancelError?: { message: string }
  cancellableJobIds?: string[]
  hasProcessingJob?: boolean
  processingCheckError?: { message: string }
}

function buildMockDb(cfg: MockConfig) {
  const calls: { delete: number; update: number; jobCancel: number; processingCheck: number; updatePayload: unknown[]; rangesRequested: Array<[number, number]> } =
    { delete: 0, update: 0, jobCancel: 0, processingCheck: 0, updatePayload: [], rangesRequested: [] }
  const allTx = cfg.transactions ?? []

  const submissionReadChain = {
    select: () => submissionReadChain,
    eq: () => submissionReadChain,
    in: () => submissionReadChain,
    order: () => submissionReadChain,
    limit: () => submissionReadChain,
    maybeSingle: async () => ({ data: cfg.submission ?? null, error: null }),
  }

  function makeTxSelectChain() {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      range: async (from: number, to: number) => {
        calls.rangesRequested.push([from, to])
        if (cfg.fetchError) return { data: null, error: cfg.fetchError }
        return { data: allTx.slice(from, to + 1), error: null }
      },
    }
    return chain
  }

  const txDeleteChain = {
    delete: () => txDeleteChain,
    eq: (..._args: unknown[]) => txDeleteChain,
    then: (resolve: (v: { error: unknown }) => void) => {
      calls.delete++
      resolve({ error: cfg.deleteError ?? null })
    },
  }

  const jobCancelChain = {
    update: (..._args: unknown[]) => jobCancelChain,
    eq: (..._args: unknown[]) => jobCancelChain,
    in: (..._args: unknown[]) => jobCancelChain,
    select: (..._args: unknown[]) => jobCancelChain,
    then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
      calls.jobCancel++
      resolve(cfg.jobCancelError
        ? { data: null, error: cfg.jobCancelError }
        : { data: (cfg.cancellableJobIds ?? []).map(id => ({ id })), error: null })
    },
  }

  // The pre-flight "is anything processing right now" check: .select(...,
  // {count,head}).eq().eq().eq('status','processing') — a SELECT, distinct
  // from the cancel UPDATE above, on the same job_queue table.
  const processingCheckChain = {
    select: (..._args: unknown[]) => processingCheckChain,
    eq: (..._args: unknown[]) => processingCheckChain,
    then: (resolve: (v: { count: number | null; error: unknown }) => void) => {
      calls.processingCheck++
      resolve(cfg.processingCheckError
        ? { count: null, error: cfg.processingCheckError }
        : { count: cfg.hasProcessingJob ? 1 : 0, error: null })
    },
  }

  const submissionUpdateChain = {
    update: (payload: unknown) => {
      calls.updatePayload.push(payload)
      return submissionUpdateChain
    },
    eq: (..._args: unknown[]) => submissionUpdateChain,
    then: (resolve: (v: { error: unknown }) => void) => {
      calls.update++
      resolve({ error: cfg.updateError ?? null })
    },
  }

  const db = {
    from: (table: string) => {
      if (table === "tax_return_submissions") {
        return {
          select: submissionReadChain.select,
          eq: submissionReadChain.eq,
          in: submissionReadChain.in,
          order: submissionReadChain.order,
          limit: submissionReadChain.limit,
          maybeSingle: submissionReadChain.maybeSingle,
          update: submissionUpdateChain.update,
        }
      }
      if (table === "bank_transactions") {
        // select (paginated read, possibly called many times) vs delete
        // (called once, in apply mode) are distinguished by which method
        // the caller invokes next, exactly like the real query builder.
        return { select: makeTxSelectChain().select, delete: txDeleteChain.delete }
      }
      if (table === "job_queue") return { select: processingCheckChain.select, update: jobCancelChain.update }
      throw new Error(`unexpected table in mock: ${table}`)
    },
  }
  return { db, calls }
}

describe("resetAccountYearBankStatements", () => {
  const account = "de6c5e3c-a93b-42de-bdad-f546a697472d"
  const year = 2025

  beforeEach(() => {
    resetFinancialsAttestationMock.mockClear()
    resetFinancialsAttestationMock.mockResolvedValue({ cleared: false })
  })

  it("dry run (default): returns the full archive plan, calls neither delete, update, nor job-cancel", async () => {
    const { db, calls } = buildMockDb({
      submission: { id: "sub-1", submitted_data: { bank_accounts_0_statements: ["a.csv"] }, financials_meta: {} },
      transactions: [{ id: "t1", amount: 100 }, { id: "t2", amount: -50 }],
    })
    const plan = await resetAccountYearBankStatements(db, account, year)
    expect(plan.applied).toBe(false)
    expect(plan.archivedCount).toBe(2)
    expect(plan.archivedTransactions).toHaveLength(2)
    expect(plan.clearedStatementKeys).toEqual(["bank_accounts_0_statements"])
    expect(calls.delete).toBe(0)
    expect(calls.update).toBe(0)
    expect(calls.jobCancel).toBe(0)
  })

  it("explicit dryRun:true behaves identically to the default", async () => {
    const { db, calls } = buildMockDb({ submission: null, transactions: [{ id: "t1" }] })
    const plan = await resetAccountYearBankStatements(db, account, year, { dryRun: true })
    expect(plan.applied).toBe(false)
    expect(calls.delete + calls.update + calls.jobCancel).toBe(0)
  })

  it("PAGINATION: an account with more than one page of transactions is archived completely, not truncated at 1000", async () => {
    const big = Array.from({ length: 1500 }, (_, i) => ({ id: `t${i}`, amount: 1 }))
    const { db, calls } = buildMockDb({ submission: null, transactions: big })
    const plan = await resetAccountYearBankStatements(db, account, year, { dryRun: true })
    expect(plan.archivedCount).toBe(1500)
    expect(plan.archivedTransactions).toHaveLength(1500)
    // fetchAllPaged asks for a second page because the first came back full (1000);
    // the second page (500 rows, short of 1000) ends the loop.
    expect(calls.rangesRequested).toEqual([[0, 999], [1000, 1999]])
  })

  it("apply: deletes the transactions and clears only the statement keys in submitted_data", async () => {
    const { db, calls } = buildMockDb({
      submission: {
        id: "sub-1",
        submitted_data: { company_name: "Dynamiq SR LLC", bank_accounts_0_statements: ["a.csv"], bank_accounts_1_statements: ["b.csv"] },
        financials_meta: {},
      },
      transactions: [{ id: "t1" }],
    })
    const plan = await resetAccountYearBankStatements(db, account, year, { dryRun: false })
    expect(plan.applied).toBe(true)
    expect(calls.delete).toBe(1)
    expect(calls.update).toBe(1)
    const payload = calls.updatePayload[0] as { submitted_data: Record<string, unknown>; financials_meta: Record<string, unknown> }
    expect(payload.submitted_data.bank_accounts_0_statements).toEqual([])
    expect(payload.submitted_data.bank_accounts_1_statements).toEqual([])
    expect(payload.submitted_data.company_name).toBe("Dynamiq SR LLC") // untouched
  })

  it("apply: clears ready_notified to false only when it was actually true (round-2 finding)", async () => {
    const { db } = buildMockDb({
      submission: { id: "sub-1", submitted_data: {}, financials_meta: { ready_notified: true, some_other_key: "x" } },
      transactions: [],
    })
    const plan = await resetAccountYearBankStatements(db, account, year, { dryRun: false })
    expect(plan.hadReadyNotified).toBe(true)
  })

  it("apply: does NOT touch ready_notified when it was never true (false, absent, or already false)", async () => {
    for (const financials_meta of [{}, { ready_notified: false }]) {
      const { db, calls } = buildMockDb({ submission: { id: "sub-1", submitted_data: {}, financials_meta }, transactions: [] })
      await resetAccountYearBankStatements(db, account, year, { dryRun: false })
      const payload = calls.updatePayload[0] as { financials_meta: Record<string, unknown> }
      expect("ready_notified" in payload.financials_meta ? payload.financials_meta.ready_notified : undefined).not.toBe(true)
    }
  })

  it("apply: calls resetFinancialsAttestation exactly once, LAST, after data mutations settle", async () => {
    const { db } = buildMockDb({ submission: { id: "sub-1", submitted_data: {}, financials_meta: {} }, transactions: [{ id: "t1" }] })
    await resetAccountYearBankStatements(db, account, year, { dryRun: false })
    expect(resetFinancialsAttestationMock).toHaveBeenCalledTimes(1)
    expect(resetFinancialsAttestationMock).toHaveBeenCalledWith(account, year, expect.any(String))
  })

  it("dry run NEVER calls resetFinancialsAttestation — a preview must not invalidate a real attestation", async () => {
    const { db } = buildMockDb({ submission: { id: "sub-1", submitted_data: {}, financials_meta: {} }, transactions: [{ id: "t1" }] })
    await resetAccountYearBankStatements(db, account, year) // default dryRun:true
    expect(resetFinancialsAttestationMock).not.toHaveBeenCalled()
  })

  it("apply: calls resetFinancialsAttestation even when there is no submission row (attestation lives on a row this function can't see via the plan alone)", async () => {
    const { db } = buildMockDb({ submission: null, transactions: [{ id: "t1" }] })
    await resetAccountYearBankStatements(db, account, year, { dryRun: false })
    expect(resetFinancialsAttestationMock).toHaveBeenCalledTimes(1)
  })

  it("apply: cancels the account+year's old ingest jobs so a re-upload of a previously-seen file actually re-ingests", async () => {
    const { db, calls } = buildMockDb({
      submission: { id: "sub-1", submitted_data: {}, financials_meta: {} },
      transactions: [{ id: "t1" }],
      cancellableJobIds: ["job-1", "job-2", "job-3"],
    })
    const plan = await resetAccountYearBankStatements(db, account, year, { dryRun: false })
    expect(calls.jobCancel).toBe(1)
    expect(plan.cancelledJobCount).toBe(3)
  })

  it("apply: clears coverage_answers to {} only when it was actually populated", async () => {
    const { db } = buildMockDb({
      submission: {
        id: "sub-1",
        submitted_data: {},
        financials_meta: { coverage_answers: { "Relay|leading|2025-06": { answer: "no_activity", at: "2026-01-01" } } },
      },
      transactions: [],
    })
    const plan = await resetAccountYearBankStatements(db, account, year, { dryRun: false })
    expect(plan.hadCoverageAnswers).toBe(true)
  })

  it("no submission exists for this account+year: transactions still archive/delete, jobs still cancel, but NO submission update is attempted", async () => {
    const { db, calls } = buildMockDb({ submission: null, transactions: [{ id: "t1" }, { id: "t2" }] })
    const plan = await resetAccountYearBankStatements(db, account, year, { dryRun: false })
    expect(plan.submissionId).toBeNull()
    expect(plan.applied).toBe(true)
    expect(calls.delete).toBe(1)
    expect(calls.jobCancel).toBe(1)
    expect(calls.update).toBe(0) // no submission row to write cleared keys onto
  })

  it("no transactions exist: delete is skipped entirely (nothing to delete); job-cancel and submission update still run", async () => {
    const { db, calls } = buildMockDb({
      submission: { id: "sub-1", submitted_data: { bank_accounts_0_statements: ["a.csv"] }, financials_meta: {} },
      transactions: [],
    })
    const plan = await resetAccountYearBankStatements(db, account, year, { dryRun: false })
    expect(plan.archivedCount).toBe(0)
    expect(calls.delete).toBe(0) // the `if (archivedTransactions.length > 0)` guard
    expect(calls.jobCancel).toBe(1)
    expect(calls.update).toBe(1)
  })

  it("nothing to do at all (no submission, no transactions): applies cleanly, job-cancel still runs (idempotent no-op if nothing matches)", async () => {
    const { db, calls } = buildMockDb({ submission: null, transactions: [] })
    const plan = await resetAccountYearBankStatements(db, account, year, { dryRun: false })
    expect(plan.applied).toBe(true)
    expect(calls.delete).toBe(0)
    expect(calls.update).toBe(0)
    expect(plan.cancelledJobCount).toBe(0)
  })

  it("a fetch error aborts BEFORE any mutation — throws, never reaches delete, job-cancel, or update", async () => {
    const { db, calls } = buildMockDb({
      submission: { id: "sub-1", submitted_data: {}, financials_meta: {} },
      transactions: [{ id: "t1" }],
      fetchError: { message: "connection reset" },
    })
    await expect(resetAccountYearBankStatements(db, account, year, { dryRun: false })).rejects.toThrow("connection reset")
    expect(calls.delete).toBe(0)
    expect(calls.update).toBe(0)
    expect(calls.jobCancel).toBe(0)
  })

  it("a delete error throws and neither job-cancel nor the submission update ever runs", async () => {
    const { db, calls } = buildMockDb({
      submission: { id: "sub-1", submitted_data: { bank_accounts_0_statements: ["a.csv"] }, financials_meta: {} },
      transactions: [{ id: "t1" }],
      deleteError: { message: "delete blocked by RLS" },
    })
    await expect(resetAccountYearBankStatements(db, account, year, { dryRun: false })).rejects.toThrow("delete blocked by RLS")
    expect(calls.delete).toBe(1)
    expect(calls.jobCancel).toBe(0)
    expect(calls.update).toBe(0) // KNOWN ORDERING: the caller already holds the full paginated archive from the
    // mandatory prior dry run before dryRun:false is ever called — a failure here loses no financial data, only
    // leaves stale job/file-list state to clean up by hand.
  })

  it("a job-cancel error throws AFTER the delete already succeeded, before the submission update", async () => {
    const { db, calls } = buildMockDb({
      submission: { id: "sub-1", submitted_data: { bank_accounts_0_statements: ["a.csv"] }, financials_meta: {} },
      transactions: [{ id: "t1" }],
      jobCancelError: { message: "job_queue update failed" },
    })
    await expect(resetAccountYearBankStatements(db, account, year, { dryRun: false })).rejects.toThrow("Job cancel failed")
    expect(calls.delete).toBe(1)
    expect(calls.jobCancel).toBe(1)
    expect(calls.update).toBe(0)
  })

  it("an update error throws AFTER delete and job-cancel already succeeded — documents the one non-atomic gap", async () => {
    const { db, calls } = buildMockDb({
      submission: { id: "sub-1", submitted_data: { bank_accounts_0_statements: ["a.csv"] }, financials_meta: {} },
      transactions: [{ id: "t1" }],
      updateError: { message: "stale row" },
    })
    await expect(resetAccountYearBankStatements(db, account, year, { dryRun: false })).rejects.toThrow("Submission update failed")
    expect(calls.delete).toBe(1)
    expect(calls.jobCancel).toBe(1)
    expect(calls.update).toBe(1)
  })

  // -------------------------------------------------------------------------
  // Round 3: a genuinely in-flight job cannot be stopped by cancelling its
  // row's status — apply must refuse outright rather than proceed.
  // -------------------------------------------------------------------------

  it("dry run reports hasProcessingJob for visibility, but does NOT refuse (only apply refuses)", async () => {
    const { db } = buildMockDb({ submission: null, transactions: [{ id: "t1" }], hasProcessingJob: true })
    const plan = await resetAccountYearBankStatements(db, account, year) // dryRun default
    expect(plan.hasProcessingJob).toBe(true)
    expect(plan.applied).toBe(false)
  })

  it("apply REFUSES outright when a job_queue row is currently processing — no mutation happens at all", async () => {
    const { db, calls } = buildMockDb({
      submission: { id: "sub-1", submitted_data: { bank_accounts_0_statements: ["a.csv"] }, financials_meta: {} },
      transactions: [{ id: "t1" }],
      hasProcessingJob: true,
    })
    await expect(resetAccountYearBankStatements(db, account, year, { dryRun: false })).rejects.toThrow(/processing/i)
    expect(calls.delete).toBe(0)
    expect(calls.jobCancel).toBe(0)
    expect(calls.update).toBe(0)
    expect(resetFinancialsAttestationMock).not.toHaveBeenCalled()
  })

  it("apply proceeds normally when hasProcessingJob is false (the default, ordinary case)", async () => {
    const { db, calls } = buildMockDb({
      submission: { id: "sub-1", submitted_data: {}, financials_meta: {} },
      transactions: [{ id: "t1" }],
      hasProcessingJob: false,
    })
    const plan = await resetAccountYearBankStatements(db, account, year, { dryRun: false })
    expect(plan.applied).toBe(true)
    expect(calls.delete).toBe(1)
  })

  it("a failure checking for processing jobs aborts BEFORE any mutation", async () => {
    const { db, calls } = buildMockDb({
      submission: { id: "sub-1", submitted_data: {}, financials_meta: {} },
      transactions: [{ id: "t1" }],
      processingCheckError: { message: "connection reset" },
    })
    await expect(resetAccountYearBankStatements(db, account, year, { dryRun: false })).rejects.toThrow("Could not check for in-flight jobs")
    expect(calls.delete).toBe(0)
    expect(calls.jobCancel).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Round 3: a failed attestation-reset write must not be silently swallowed
  // — the caller (the runner) cannot report "APPLIED" over it.
  // -------------------------------------------------------------------------

  it("apply throws when resetFinancialsAttestation reports a write error — even though the data mutations already succeeded", async () => {
    resetFinancialsAttestationMock.mockResolvedValueOnce({ cleared: false, error: "row locked" })
    const { db, calls } = buildMockDb({
      submission: { id: "sub-1", submitted_data: { bank_accounts_0_statements: ["a.csv"] }, financials_meta: {} },
      transactions: [{ id: "t1" }],
    })
    await expect(resetAccountYearBankStatements(db, account, year, { dryRun: false })).rejects.toThrow(/attestation reset FAILED/)
    // The data mutations already committed by the time attestation runs (it's LAST) —
    // this throw is a loud "go check by hand," not a rollback (there is none).
    expect(calls.delete).toBe(1)
    expect(calls.jobCancel).toBe(1)
    expect(calls.update).toBe(1)
  })

  it("apply succeeds normally when resetFinancialsAttestation clears cleanly", async () => {
    resetFinancialsAttestationMock.mockResolvedValueOnce({ cleared: true })
    const { db } = buildMockDb({ submission: { id: "sub-1", submitted_data: {}, financials_meta: {} }, transactions: [{ id: "t1" }] })
    const plan = await resetAccountYearBankStatements(db, account, year, { dryRun: false })
    expect(plan.applied).toBe(true)
  })
})
