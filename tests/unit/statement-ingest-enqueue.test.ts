import { describe, it, expect, vi, beforeEach } from "vitest"

// ── supabase-admin: dedup via select().eq().neq() → existingRows; DIRECT
//    insert() captured in jobInserts (the code inserts straight into job_queue,
//    NOT via enqueueJobs — that would dangle triggerWorker on Vercel). ──
let existingRows: Array<{ payload: { path?: string } }> = []
const jobInserts: unknown[] = []
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.neq = () => Promise.resolve({ data: existingRows, error: null })
      chain.insert = (rows: unknown) => { jobInserts.push(rows); return Promise.resolve({ error: null }) }
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
  jobInserts.length = 0
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
    expect(jobInserts).toHaveLength(0)
  })

  it("enqueues one job per new statement file", async () => {
    const r = await enqueueStatementIngestJobs({
      accountId: "acc-1", taxYear: 2025,
      uploadPaths: [p("bank_accounts_0_statements_aa_Chase.csv"), p("bank_accounts_1_statements_bb_Mercury.csv")],
      submittedData: { bank_accounts_0_bank_name: "Chase", bank_accounts_1_bank_name: "Mercury" },
    })
    expect(r).toEqual({ enqueued: 2, skipped: 0 })
    expect(jobInserts).toHaveLength(1)
    const rows = jobInserts[0] as Array<{ payload: { path: string; bank_label: string; tax_year: number } }>
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
    const rows = jobInserts[0] as Array<{ payload: { path: string } }>
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
    expect(jobInserts).toHaveLength(0)
  })
})

// ── Card 4a39e0fd — bucket passthrough (external tax form wiring) ──
describe("enqueueStatementIngestJobs — bucket", () => {
  it("stamps the payload bucket when given, omits it by default", async () => {
    jobInserts.length = 0
    await enqueueStatementIngestJobs({
      accountId: "acc-1", taxYear: 2025,
      uploadPaths: ["tok/a1/bank_statements_x_wise.csv"],
      submittedData: {}, bucket: "tax-form-uploads",
    })
    const rows = jobInserts[0] as Array<{ payload: { bucket?: string } }>
    expect(rows[0].payload.bucket).toBe("tax-form-uploads")

    jobInserts.length = 0
    await enqueueStatementIngestJobs({
      accountId: "acc-1", taxYear: 2025,
      uploadPaths: ["tok/a1/bank_statements_x_wise.csv"],
      submittedData: {},
    })
    const rows2 = jobInserts[0] as Array<{ payload: Record<string, unknown> }>
    expect("bucket" in rows2[0].payload).toBe(false)
  })
})
