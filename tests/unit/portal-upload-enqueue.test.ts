import { describe, it, expect, vi, beforeEach } from "vitest"

// ── supabase-admin mock ──
// storage.from(bucket).upload(path, buf, opts) → captured in uploadCalls
// from("job_queue").select().eq().eq().eq().neq().limit() → existingRows
// from("job_queue").insert(row) → captured in jobInserts
let existingRows: Array<{ id: string }> = []
let uploadError: { message: string } | null = null
let insertError: { message: string } | null = null
const uploadCalls: Array<{ bucket: string; path: string; opts: unknown }> = []
const jobInserts: unknown[] = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    storage: {
      from: (bucket: string) => ({
        upload: (path: string, _buf: unknown, opts: unknown) => {
          uploadCalls.push({ bucket, path, opts })
          return Promise.resolve({ error: uploadError })
        },
      }),
    },
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.neq = () => chain
      chain.limit = () => Promise.resolve({ data: existingRows, error: null })
      chain.insert = (row: unknown) => { jobInserts.push(row); return Promise.resolve({ error: insertError }) }
      return chain
    },
  },
}))

import { saveAndEnqueueStatementUpload } from "@/lib/tax/portal-upload-enqueue"
import { sha256Hex } from "@/lib/tax/statement-uploads"

const INPUT = {
  accountId: "acc-1",
  taxYear: 2025,
  bankLabel: "My Mercury",
  buffer: Buffer.from("date,amount\n2025-01-01,100"),
  fileName: "Mercury 2025.csv",
}

beforeEach(() => {
  existingRows = []
  uploadError = null
  insertError = null
  uploadCalls.length = 0
  jobInserts.length = 0
})

describe("saveAndEnqueueStatementUpload", () => {
  it("new file → archives to onboarding-uploads and enqueues an ingest job", async () => {
    const r = await saveAndEnqueueStatementUpload(INPUT)
    expect(r.queued).toBe(true)
    expect(r.alreadyQueued).toBe(false)

    // archived to the right bucket, content-hashed + year-namespaced path
    expect(uploadCalls).toHaveLength(1)
    expect(uploadCalls[0].bucket).toBe("onboarding-uploads")
    const sha = sha256Hex(INPUT.buffer)
    expect(uploadCalls[0].path).toBe(`tax/acc-1/2025/${sha.slice(0, 16)}_Mercury_2025.csv`)
    expect((uploadCalls[0].opts as { contentType: string }).contentType).toBe("text/csv")

    // enqueued exactly one ingest_bank_statement job carrying that path
    expect(jobInserts).toHaveLength(1)
    const job = jobInserts[0] as { job_type: string; payload: { account_id: string; tax_year: number; path: string; bank_label: string } }
    expect(job.job_type).toBe("ingest_bank_statement")
    expect(job.payload.account_id).toBe("acc-1")
    expect(job.payload.tax_year).toBe(2025)
    expect(job.payload.path).toBe(r.path)
    expect(job.payload.bank_label).toBe("My Mercury")
  })

  it("idempotent: a non-failed job already exists for this exact file → no re-enqueue", async () => {
    existingRows = [{ id: "existing-job" }]
    const r = await saveAndEnqueueStatementUpload(INPUT)
    expect(r.queued).toBe(false)
    expect(r.alreadyQueued).toBe(true)
    // still archived (upsert is harmless), but NOT re-enqueued
    expect(uploadCalls).toHaveLength(1)
    expect(jobInserts).toHaveLength(0)
  })

  it("PDF → application/pdf content type", async () => {
    await saveAndEnqueueStatementUpload({ ...INPUT, fileName: "statement.PDF" })
    expect((uploadCalls[0].opts as { contentType: string }).contentType).toBe("application/pdf")
  })

  it("storage failure → throws a guiding error, never enqueues", async () => {
    uploadError = { message: "bucket unavailable" }
    await expect(saveAndEnqueueStatementUpload(INPUT)).rejects.toThrow(/Could not save your file/)
    expect(jobInserts).toHaveLength(0)
  })

  it("enqueue failure → throws a guiding error", async () => {
    insertError = { message: "insert denied" }
    await expect(saveAndEnqueueStatementUpload(INPUT)).rejects.toThrow(/Could not queue your file/)
  })
})
