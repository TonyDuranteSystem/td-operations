import { describe, it, expect, vi, beforeEach } from "vitest"

// ── enqueueJobs spy ──
const enqueueJobsMock = vi.fn(async (..._a: unknown[]) => ({ ids: ["j1"] }))
vi.mock("@/lib/jobs/queue", () => ({ enqueueJobs: (...a: unknown[]) => enqueueJobsMock(...a) }))

// ── supabase-admin: job_queue.select(...).eq().eq().neq() resolves to existing rows ──
let existingRows: Array<{ payload: { path?: string } }> = []
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.neq = () => Promise.resolve({ data: existingRows, error: null })
      return chain
    },
  },
}))

import {
  filterStatementPaths,
  bankLabelForPath,
  enqueueStatementIngestJobs,
} from "@/lib/tax/statement-ingest-enqueue"

const base = "tax/acc-1"
const p = (n: string) => `${base}/${n}`

beforeEach(() => {
  enqueueJobsMock.mockClear()
  existingRows = []
})

describe("filterStatementPaths", () => {
  it("keeps per-bank + legacy statement files (csv/pdf/zip), drops everything else", () => {
    const paths = [
      p("bank_accounts_0_statements_ab12_Chase.csv"),
      p("bank_accounts_1_statements_cd34_Mercury.pdf"),
      p("bank_statements_ef56_Old.zip"),
      p("bank_accounts_0_bank_name.txt"), // not a statement file
      p("prior_year_return_99_return.pdf"), // not a statement
      p("bank_accounts_0_statements_xx_notes.docx"), // wrong extension
    ]
    expect(filterStatementPaths(paths)).toEqual([
      p("bank_accounts_0_statements_ab12_Chase.csv"),
      p("bank_accounts_1_statements_cd34_Mercury.pdf"),
      p("bank_statements_ef56_Old.zip"),
    ])
  })
})

describe("bankLabelForPath", () => {
  it("prefers the typed per-bank name", () => {
    expect(
      bankLabelForPath(p("bank_accounts_2_statements_aa_relay.csv"), { bank_accounts_2_bank_name: "My Relay" }),
    ).toBe("My Relay")
  })
  it("falls back to the filename lead token when no typed name", () => {
    expect(bankLabelForPath(p("bank_accounts_0_statements_aa_Chase_2025.csv"), {})).toBe("Chase")
  })
})

describe("enqueueStatementIngestJobs", () => {
  it("no statement files → enqueues nothing", async () => {
    const r = await enqueueStatementIngestJobs({
      accountId: "acc-1", taxYear: 2025, uploadPaths: [p("prior_year_return_x.pdf")], submittedData: {},
    })
    expect(r).toEqual({ enqueued: 0, skipped: 0 })
    expect(enqueueJobsMock).not.toHaveBeenCalled()
  })

  it("enqueues one job per new statement file", async () => {
    const r = await enqueueStatementIngestJobs({
      accountId: "acc-1", taxYear: 2025,
      uploadPaths: [p("bank_accounts_0_statements_aa_Chase.csv"), p("bank_accounts_1_statements_bb_Mercury.csv")],
      submittedData: { bank_accounts_0_bank_name: "Chase", bank_accounts_1_bank_name: "Mercury" },
    })
    expect(r).toEqual({ enqueued: 2, skipped: 0 })
    expect(enqueueJobsMock).toHaveBeenCalledTimes(1)
    const rows = enqueueJobsMock.mock.calls[0][0] as Array<{ payload: { path: string; bank_label: string; tax_year: number } }>
    expect(rows).toHaveLength(2)
    expect(rows[0].payload.bank_label).toBe("Chase")
    expect(rows[0].payload.tax_year).toBe(2025)
  })

  it("idempotent: skips a file that already has a non-failed job, enqueues only the new one", async () => {
    existingRows = [{ payload: { path: p("bank_accounts_0_statements_aa_Chase.csv") } }]
    const r = await enqueueStatementIngestJobs({
      accountId: "acc-1", taxYear: 2025,
      uploadPaths: [p("bank_accounts_0_statements_aa_Chase.csv"), p("bank_accounts_1_statements_bb_Mercury.csv")],
      submittedData: {},
    })
    expect(r).toEqual({ enqueued: 1, skipped: 1 })
    const rows = enqueueJobsMock.mock.calls[0][0] as Array<{ payload: { path: string } }>
    expect(rows).toHaveLength(1)
    expect(rows[0].payload.path).toBe(p("bank_accounts_1_statements_bb_Mercury.csv"))
  })

  it("all files already queued → enqueues nothing", async () => {
    existingRows = [
      { payload: { path: p("bank_accounts_0_statements_aa_Chase.csv") } },
    ]
    const r = await enqueueStatementIngestJobs({
      accountId: "acc-1", taxYear: 2025,
      uploadPaths: [p("bank_accounts_0_statements_aa_Chase.csv")],
      submittedData: {},
    })
    expect(r).toEqual({ enqueued: 0, skipped: 1 })
    expect(enqueueJobsMock).not.toHaveBeenCalled()
  })
})
