import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mocks ──
const parseMock = vi.fn()
vi.mock("@/lib/bank-statement-parser", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/bank-statement-parser")>()
  return { ...orig, parseBankStatement: (...args: unknown[]) => parseMock(...args) }
})

const upsertCalls: unknown[] = []
const existingRows: unknown[] = []
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "account_contacts") {
        return { select: () => ({ eq: () => Promise.resolve({ data: [] }) }) }
      }
      if (table === "bank_transactions") {
        return {
          // loadExistingRows path: select().eq().eq()
          select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: existingRows, error: null }) }) }),
          upsert: (row: unknown) => { upsertCalls.push(row); return Promise.resolve({ error: null }) },
        }
      }
      if (table === "tax_return_submissions") {
        // resetFinancialsAttestation lookup — no attested submission in these tests
        const chain = {
          select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: null }),
        }
        return chain
      }
      if (table === "job_queue") {
        // dedup lookup for the recategorize_ai enqueue: select().eq().eq().eq().in().limit()
        const chain = {
          select: () => chain, eq: () => chain, in: () => chain,
          limit: () => Promise.resolve({ data: [], error: null }),
        }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  },
}))

const enqueueJobsMock = vi.fn(async (..._a: unknown[]) => ({ ids: ["job-ai-1"] }))
vi.mock("@/lib/jobs/queue", () => ({ enqueueJobs: (...a: unknown[]) => enqueueJobsMock(...a) }))

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

beforeEach(() => { parseMock.mockReset(); recatMock.mockClear(); enqueueJobsMock.mockClear(); upsertCalls.length = 0; existingRows.length = 0 })

describe("ingestPortalCsv", () => {
  it("unreadable file → guiding error, nothing inserted", async () => {
    parseMock.mockResolvedValue({ transactions: [], bank_name: "unknown", errors: ["Could not find required columns"] })
    const r = await ingestPortalCsv(INPUT)
    expect(r.ok).toBe(false)
    expect(r.error).toContain("a CSV or the official PDF")
    expect(r.error).toContain("Do not merge, combine, or edit")
    expect(upsertCalls).toHaveLength(0)
  })

  it("wrong-period file → guiding error naming the year", async () => {
    parseMock.mockResolvedValue({ transactions: [parsedTx("2024-05-01", "r1")], bank_name: "Mercury", errors: [] })
    const r = await ingestPortalCsv(INPUT)
    expect(r.ok).toBe(false)
    expect(r.error).toContain("entire year 2025")
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
    expect(enqueueJobsMock).toHaveBeenCalledTimes(1)
    const aiJob = (enqueueJobsMock.mock.calls[0][0] as Array<{ job_type: string; payload: unknown }>)[0]
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
})
