import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mocks ──
const parseMock = vi.fn()
vi.mock("@/lib/bank-statement-parser", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/bank-statement-parser")>()
  return { ...orig, parseBankStatement: (...args: unknown[]) => parseMock(...args) }
})

const upsertCalls: unknown[] = []
const existingRows: unknown[] = []
const jobInserts: unknown[] = []
let existingSourceCount = 0
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "account_contacts") {
        return { select: () => ({ eq: () => Promise.resolve({ data: [] }) }) }
      }
      if (table === "bank_transactions") {
        // Chainable thenable: serves BOTH the idempotency count query
        // (select('id',{count,head}).eq().eq().eq() → {count}) and
        // loadExistingRows (select().eq().eq() → {data}).
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.upsert = (row: unknown) => { upsertCalls.push(row); return Promise.resolve({ error: null }) }
        chain.then = (resolve: (v: unknown) => unknown) =>
          resolve({ data: existingRows, count: existingSourceCount, error: null })
        return chain
      }
      if (table === "tax_return_submissions") {
        // resetFinancialsAttestation lookup — no attested submission in these
        // tests. `.in` joined the chain when the reset moved to the shared
        // submission resolver (card 4a39e0fd, statuses completed+reviewed).
        const chain = {
          select: () => chain, eq: () => chain, in: () => chain, order: () => chain, limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: null }),
        }
        return chain
      }
      if (table === "job_queue") {
        // dedup lookup: select().eq().eq().eq().in().limit() → no existing job.
        // + DIRECT insert (not enqueueJobs — that would dangle triggerWorker).
        const chain = {
          select: () => chain, eq: () => chain, in: () => chain,
          limit: () => Promise.resolve({ data: [], error: null }),
          insert: (rows: unknown) => { jobInserts.push(rows); return Promise.resolve({ error: null }) },
        }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  },
}))

const recatMock = vi.fn().mockResolvedValue({ scanned: 0, recategorized: 0, transferPairs: 0, aiCategorized: 0, aiErrors: [], uncategorizedRemaining: 3 })
vi.mock("@/lib/tax/categorization-engine", () => ({
  recategorizeAccountYear: (...args: unknown[]) => recatMock(...args),
}))

import { ingestPortalCsv } from "@/lib/tax/portal-csv-ingest"
import { sha256Hex, uploadSourceId } from "@/lib/tax/statement-uploads"

function parsedTx(date: string, ref: string, amount = -10) {
  return {
    transaction_date: date, description: "d", counterparty: "", amount, currency: "USD",
    balance_after: null, transaction_ref: ref, bank_name: "Mercury", account_type: "Checking",
  }
}

const INPUT = {
  accountId: "acc-1", taxYear: 2025, bankLabel: "My Mercury", accountKind: "checking",
  buffer: Buffer.from("csv-content"), fileName: "export.csv",
}

beforeEach(() => { parseMock.mockReset(); recatMock.mockClear(); jobInserts.length = 0; upsertCalls.length = 0; existingRows.length = 0; existingSourceCount = 0 })

describe("ingestPortalCsv", () => {
  it("idempotent: same file content already ingested → ok WITHOUT re-parsing (no flip-to-failed)", async () => {
    // This exact file's source_file_id already has 94 rows. A non-deterministic
    // PDF re-extraction must NOT flip it to failed — short-circuit to success.
    existingSourceCount = 94
    const r = await ingestPortalCsv(INPUT)
    expect(r.ok).toBe(true)
    expect(r.alert).toContain("already processed")
    expect(r.parsed).toBe(94)
    expect(r.inserted).toBe(0)
    expect(parseMock).not.toHaveBeenCalled() // never re-parsed
    expect(upsertCalls).toHaveLength(0)
  })

  it("unreadable file → guiding error + 'unreadable' diagnosis, nothing inserted", async () => {
    parseMock.mockResolvedValue({ transactions: [], bank_name: "unknown", errors: ["Could not find required columns"] })
    const r = await ingestPortalCsv(INPUT)
    expect(r.ok).toBe(false)
    expect(r.error).toContain("the CSV or the official PDF")
    expect(r.error).toContain("Do not merge, combine, or edit")
    expect(r.diagnosis?.code).toBe("unreadable")
    expect(upsertCalls).toHaveLength(0)
  })

  it("wrong-period file → 'wrong_year' diagnosis naming BOTH years (the PAMAG shape)", async () => {
    parseMock.mockResolvedValue({ transactions: [parsedTx("2024-05-01", "r1")], bank_name: "Mercury", errors: [] })
    const r = await ingestPortalCsv(INPUT)
    expect(r.ok).toBe(false)
    // Wave 2 (Antonio): say WHAT is wrong — the years the file holds and the
    // year we need — never ask the client why.
    expect(r.error).toContain("2024")
    expect(r.error).toContain("we need 2025")
    expect(r.diagnosis).toEqual({ code: "wrong_year", found_years: [2024], expected_year: 2025 })
  })

  it("accounting export (QuickBooks headers) → 'not_bank_statement' diagnosis (the Nova Ratio shape)", async () => {
    parseMock.mockResolvedValue({ transactions: [], bank_name: "unknown", errors: [] })
    const qbBuffer = Buffer.from('"Date","Transaction Type","Num","Posting","Memo/Description","Amount"\n', "utf8")
    const r = await ingestPortalCsv({ ...INPUT, buffer: qbBuffer })
    expect(r.ok).toBe(false)
    expect(r.diagnosis?.code).toBe("not_bank_statement")
    expect(r.diagnosis?.software).toBe("QuickBooks")
    expect(r.error).toContain("accounting export")
    expect(r.error).toContain("download the transactions CSV from your bank")
  })

  it("empty-but-valid month carries the 'empty_period' diagnosis", async () => {
    parseMock.mockResolvedValue({ transactions: [], bank_name: "Relay", errors: ["Empty CSV"], recognized_empty: true })
    const r = await ingestPortalCsv(INPUT)
    expect(r.ok).toBe(true)
    expect(r.emptyStatement).toBe(true)
    expect(r.diagnosis?.code).toBe("empty_period")
  })

  it("identical file already ingested → alert, NO insert", async () => {
    const sha = sha256Hex(INPUT.buffer)
    existingRows.push({ transaction_ref: "r1", transaction_date: "2025-01-05", bank_name: "Mercury", source_file_id: uploadSourceId(sha) })
    parseMock.mockResolvedValue({ transactions: [parsedTx("2025-01-05", "r1")], bank_name: "Mercury", errors: [] })
    const r = await ingestPortalCsv(INPUT)
    expect(r.ok).toBe(true)
    expect(r.alert).toContain("already uploaded this exact file")
    expect(r.inserted).toBe(0)
    expect(upsertCalls).toHaveLength(0)
  })

  it("clean file → inserts source-keyed rows, runs categorization, reports months", async () => {
    parseMock.mockResolvedValue({
      transactions: [parsedTx("2025-01-05", "r1", 100), parsedTx("2025-12-20", "r2", -50)],
      bank_name: "Mercury", errors: [],
    })
    const r = await ingestPortalCsv(INPUT)
    expect(r.ok).toBe(true)
    expect(r.inserted).toBe(2)
    expect(r.months).toEqual(["2025-01", "2025-12"])
    expect(r.bankDetected).toBe("Mercury")
    expect(r.uncategorizedRemaining).toBe(3)
    const row = upsertCalls[0] as Record<string, unknown>
    expect(row.source_file_id).toBe(uploadSourceId(sha256Hex(INPUT.buffer)))
    expect(row.tax_year).toBe(2025)
    // deterministic pass runs inline (1 call); the AI pass is ENQUEUED as a
    // background job (not a dangling promise — prod fire-and-forget fix).
    expect(recatMock).toHaveBeenCalledTimes(1)
    expect(recatMock.mock.calls[0][2]).toBeUndefined()
    // AI pass enqueued via a DIRECT job_queue insert (no enqueueJobs/triggerWorker).
    expect(jobInserts).toHaveLength(1)
    const aiJob = jobInserts[0] as { job_type: string; payload: unknown }
    expect(aiJob.job_type).toBe("recategorize_ai")
    expect(aiJob.payload).toEqual({ account_id: "acc-1", tax_year: 2025 })
  })

  it("unknown bank signature → falls back to the client's label", async () => {
    parseMock.mockResolvedValue({
      transactions: [{ ...parsedTx("2025-03-01", "r9"), bank_name: "unknown" }],
      bank_name: "unknown", errors: [],
    })
    const r = await ingestPortalCsv(INPUT)
    expect(r.ok).toBe(true)
    expect(r.bankDetected).toBe("My Mercury")
    expect((upsertCalls[0] as Record<string, unknown>).bank_name).toBe("My Mercury")
  })

  // ── Card 4a39e0fd — empty-but-valid + quarantine ──

  it("recognized-empty statement → ok:true emptyStatement, NOT the corrupt-file error", async () => {
    // A real Relay June with zero activity: signature matched, parsed cleanly,
    // no transactions. Used to fail as "could not read" and scold the client.
    parseMock.mockResolvedValue({ transactions: [], bank_name: "Relay", errors: [], recognized_empty: true })
    const r = await ingestPortalCsv(INPUT)
    expect(r.ok).toBe(true)
    expect(r.emptyStatement).toBe(true)
    expect(r.error).toBeUndefined()
    expect(r.alert).toContain("no transactions for its period")
    expect(r.inserted).toBe(0)
    expect(upsertCalls).toHaveLength(0)
    // NEGATIVE (mutation guard): without the flag the same zero-row parse is
    // still the unreadable error — the empty path must not widen.
    parseMock.mockResolvedValue({ transactions: [], bank_name: "Relay", errors: [] })
    const r2 = await ingestPortalCsv(INPUT)
    expect(r2.ok).toBe(false)
    expect(r2.emptyStatement).toBeUndefined()
  })

  it("quarantined format → ok:false with quarantine payload, calm client copy, nothing inserted", async () => {
    parseMock.mockResolvedValue({
      transactions: [], bank_name: "QB Export", errors: ["needs confirmation"],
      extraction_method: "quarantined",
      quarantine: { mapping_id: "map-1", fingerprint: "fp-1", bank_label: "QB Export", ambiguities: ["amount sign unclear"], sample: null },
    })
    const r = await ingestPortalCsv(INPUT)
    expect(r.ok).toBe(false)
    expect(r.quarantine).toEqual({ mapping_id: "map-1", fingerprint: "fp-1", bank_label: "QB Export", ambiguities: ["amount sign unclear"] })
    expect(r.error).toContain("Nothing is needed from you")
    // Never the delete-and-re-upload / do-not-merge scolding for a format WE must confirm.
    expect(r.error).not.toContain("Do not merge")
    expect(upsertCalls).toHaveLength(0)
  })

  it("passes the S1 mapping store to the parser (client uploads get learned formats + quarantine)", async () => {
    parseMock.mockResolvedValue({ transactions: [parsedTx("2025-01-05", "r1")], bank_name: "Mercury", errors: [] })
    await ingestPortalCsv(INPUT)
    const opts = parseMock.mock.calls[0][3] as { taxYear: number; mappingStore?: unknown }
    expect(opts.taxYear).toBe(2025)
    // The store's presence is the whole S1 gate in parseBankStatement — its
    // absence silently re-enables the generic parser (the Dynamiq
    // double-conversion origin).
    expect(opts.mappingStore).toBeTruthy()
  })

  it("transient AI transport failure → ok:false transient (never the corrupt-file error)", async () => {
    parseMock.mockResolvedValue({ transactions: [], bank_name: "unknown", errors: ["Claude API error 529"], transient_failure: true })
    const r = await ingestPortalCsv(INPUT)
    expect(r.ok).toBe(false)
    expect(r.transient).toBe(true)
    expect(r.error).not.toContain("Do not merge")
    expect(upsertCalls).toHaveLength(0)
  })
})
