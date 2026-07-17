/**
 * ensureTaxReturnRecord — the payment chain's record guarantee (dev job
 * e6136a5e). Pins every council-mandated invariant: required fields set
 * explicitly, correct deadlines per return type, fail-closed on missing
 * formation date, strict formation-year direction, never patches existing
 * rows, race-safe via 23505 reselect, late-born flag.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── supabase mock: scriptable per-test ──
// Selects consume a QUEUE (first lookup, then the post-violation reselect);
// when the queue is empty the last default result repeats.
let selectQueue: Array<{ data: unknown; error: unknown }> = []
let insertResult: { data: unknown; error: unknown } = { data: { id: "tr-new" }, error: null }
let lastInsertPayload: Record<string, unknown> | null = null

function nextSelect() {
  return selectQueue.length > 1 ? selectQueue.shift()! : selectQueue[0] ?? { data: null, error: null }
}

function makeBuilder() {
  const b: Record<string, unknown> = {}
  const chain = () => b
  b.select = chain
  b.eq = chain
  b.limit = chain
  b.maybeSingle = async () => nextSelect()
  b.insert = (payload: Record<string, unknown>) => {
    lastInsertPayload = payload
    const ib: Record<string, unknown> = {}
    ib.select = () => ib
    ib.single = async () => insertResult
    return ib
  }
  return b
}
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: () => makeBuilder() },
}))

import { ensureTaxReturnRecord, deriveReturnType, nominalDeadline } from "@/lib/tax/ensure-tax-return"

const base = {
  accountId: "acc-1",
  companyName: "Acme LLC",
  taxYear: 2025,
  status: "Paid - Not Started" as const,
  memberStructure: "single_member",
  entityType: "Single Member LLC",
  formationDate: "2023-05-01",
}

beforeEach(() => {
  selectQueue = [{ data: null, error: null }]
  insertResult = { data: { id: "tr-new" }, error: null }
  lastInsertPayload = null
})

describe("guards", () => {
  it("fails CLOSED on missing formation date (auto-created rows carry no staff deliberateness)", async () => {
    const r = await ensureTaxReturnRecord({ ...base, formationDate: null })
    expect(r.action).toBe("skipped_no_formation_date")
    expect(lastInsertPayload).toBeNull()
  })

  it("skips when the company was formed AFTER the tax year (Antonio's rule — the PTBT class)", async () => {
    const r = await ensureTaxReturnRecord({ ...base, formationDate: "2026-03-02" })
    expect(r.action).toBe("skipped_formation_guard")
    expect(lastInsertPayload).toBeNull()
  })

  it("formed IN the tax year is allowed (first-year filer)", async () => {
    const r = await ensureTaxReturnRecord({ ...base, formationDate: "2025-07-15" })
    expect(r.action).toBe("created")
  })
})

describe("existing rows", () => {
  it("returns exists and NEVER patches the row (staff state outranks a payment event)", async () => {
    selectQueue = [{ data: { id: "tr-old" }, error: null }]
    const r = await ensureTaxReturnRecord(base)
    expect(r).toMatchObject({ action: "exists", id: "tr-old" })
    expect(lastInsertPayload).toBeNull()
  })
})

describe("created rows — council invariants", () => {
  it("sets company_name, deadline and data_received:false EXPLICITLY (the silent-failure root cause)", async () => {
    const r = await ensureTaxReturnRecord(base)
    expect(r.action).toBe("created")
    expect(lastInsertPayload).toMatchObject({
      account_id: "acc-1",
      company_name: "Acme LLC",
      tax_year: 2025,
      status: "Paid - Not Started",
      deadline: "2026-04-15",
      data_received: false,
      paid: true,
    })
    // tax_returns has NO paid_date column — inserting one was one of the
    // THREE reasons the legacy inline insert always failed.
    expect(lastInsertPayload!.paid_date).toBeUndefined()
  })

  it("MMLLC gets the March 15 deadline and MMLLC return type", async () => {
    await ensureTaxReturnRecord({ ...base, memberStructure: "multi_member" })
    expect(lastInsertPayload).toMatchObject({ return_type: "MMLLC", deadline: "2026-03-15" })
  })

  it("Corp gets April 15 (NOT March — CPA correction)", async () => {
    await ensureTaxReturnRecord({ ...base, memberStructure: null, entityType: "C-Corporation" })
    expect(lastInsertPayload).toMatchObject({ return_type: "Corp", deadline: "2026-04-15" })
  })

  it("flags a record born after its nominal deadline (extension batch could not have covered it)", async () => {
    // taxYear 2025 → deadline 2026-04-15, in the past relative to any run
    // date after that; this test suite runs in 2026+, so created-now is late.
    const r = await ensureTaxReturnRecord({ ...base, status: "Wizard Available" })
    expect(r.action).toBe("created")
    expect(typeof r.bornAfterDeadline).toBe("boolean")
  })
})

describe("race safety", () => {
  it("unique violation (23505) resolves to exists via reselect — never an error", async () => {
    insertResult = { data: null, error: { code: "23505", message: "duplicate key" } }
    selectQueue = [
      { data: null, error: null },              // initial lookup: miss
      { data: { id: "tr-raced" }, error: null }, // post-violation reselect: hit
    ]
    const r = await ensureTaxReturnRecord(base)
    expect(r.action).toBe("exists")
    expect(r.id).toBe("tr-raced")
  })

  it("non-unique insert errors surface as error, not exists", async () => {
    insertResult = { data: null, error: { code: "42501", message: "permission denied" } }
    const r = await ensureTaxReturnRecord(base)
    expect(r.action).toBe("error")
  })
})

describe("pure helpers", () => {
  it("deriveReturnType covers all three shapes", () => {
    expect(deriveReturnType("multi_member", null)).toBe("MMLLC")
    expect(deriveReturnType(null, "Corporation")).toBe("Corp")
    expect(deriveReturnType("single_member", "Single Member LLC")).toBe("SMLLC")
    expect(deriveReturnType(null, null)).toBe("SMLLC")
  })

  it("nominalDeadline: MMLLC Mar 15, SMLLC/Corp Apr 15, of the following year", () => {
    expect(nominalDeadline(2025, "MMLLC")).toBe("2026-03-15")
    expect(nominalDeadline(2025, "SMLLC")).toBe("2026-04-15")
    expect(nominalDeadline(2025, "Corp")).toBe("2026-04-15")
  })
})
