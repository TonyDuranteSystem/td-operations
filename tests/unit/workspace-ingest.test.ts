import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mocks ──
const parseMock = vi.fn()
vi.mock("@/lib/bank-statement-parser", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/bank-statement-parser")>()
  return { ...orig, parseBankStatement: (...args: unknown[]) => parseMock(...args) }
})

const upsertCalls: unknown[] = []
let existingSourceCount = 0
// transaction_refs in this set simulate a row silently dropped by the DB's
// ON CONFLICT DO NOTHING (a real dedup skip) — .select("id") returns no row
// for these, matching real Postgres behavior.
const dupRefs = new Set<string>()
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "pnl_workspace_transactions") {
        // Chainable thenable: serves BOTH the idempotency count query
        // (select('id',{count,head}).eq().eq() → {count}) and the insert loop
        // (upsert() → {select}).
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.upsert = (row: unknown) => {
          upsertCalls.push(row)
          const ref = (row as { transaction_ref?: string }).transaction_ref
          const skipped = ref !== undefined && dupRefs.has(ref)
          return { select: () => Promise.resolve({ data: skipped ? [] : [{ id: `id-${upsertCalls.length}` }], error: null }) }
        }
        chain.then = (resolve: (v: unknown) => unknown) =>
          resolve({ count: existingSourceCount, data: [], error: null })
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
  },
}))

const recatMock = vi.fn().mockResolvedValue({ uncategorizedRemaining: 0 })
vi.mock("@/lib/tax/workspace-recategorize", () => ({
  recategorizeWorkspace: (...args: unknown[]) => recatMock(...args),
}))

import { ingestWorkspaceCsv } from "@/lib/tax/workspace-ingest"
import { sha256Hex, uploadSourceId } from "@/lib/tax/statement-uploads"

function parsedTx(date: string, ref: string, amount = -10) {
  return {
    transaction_date: date, description: "d", counterparty: "", amount, currency: "USD",
    balance_after: null, transaction_ref: ref, bank_name: "Mercury", account_type: "Checking",
  }
}

const INPUT = {
  workspaceId: "ws-1", taxYear: 2025, bankLabel: "My Mercury",
  buffer: Buffer.from("csv-content"), fileName: "export.csv",
  linkedAccountId: null, companyName: "Test Co", memberNames: [],
}

beforeEach(() => {
  parseMock.mockReset(); recatMock.mockClear()
  upsertCalls.length = 0; existingSourceCount = 0; dupRefs.clear()
})

describe("ingestWorkspaceCsv", () => {
  it("a row silently dropped as a duplicate is NOT counted as inserted (same fix as the portal path)", async () => {
    dupRefs.add("r-dup")
    parseMock.mockResolvedValue({
      transactions: [parsedTx("2025-01-05", "r-new", 100), parsedTx("2025-01-06", "r-dup", -50)],
      bank_name: "Mercury", errors: [],
    })
    const r = await ingestWorkspaceCsv(INPUT)
    expect(r.ok).toBe(true)
    expect(r.parsed).toBe(2)
    expect(upsertCalls).toHaveLength(2) // both rows were attempted
    expect(r.inserted).toBe(1) // only the genuinely new row actually landed
  })

  it("clean file with no duplicates → every row counted as inserted", async () => {
    parseMock.mockResolvedValue({
      transactions: [parsedTx("2025-01-05", "r1", 100), parsedTx("2025-12-20", "r2", -50)],
      bank_name: "Mercury", errors: [],
    })
    const r = await ingestWorkspaceCsv(INPUT)
    expect(r.ok).toBe(true)
    expect(r.inserted).toBe(2)
    expect(r.parsed).toBe(2)
  })

  it("identical file already ingested → alert, no re-parse, no insert", async () => {
    const sha = sha256Hex(INPUT.buffer)
    existingSourceCount = 12
    const r = await ingestWorkspaceCsv(INPUT)
    expect(r.ok).toBe(true)
    expect(r.alert).toContain("already processed")
    expect(r.inserted).toBe(0)
    expect(r.sourceFileId).toBe(uploadSourceId(sha))
    expect(parseMock).not.toHaveBeenCalled()
    expect(upsertCalls).toHaveLength(0)
  })
})
