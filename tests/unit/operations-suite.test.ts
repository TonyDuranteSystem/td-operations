/**
 * lib/operations/suite.ts — the application's client for the suite lock.
 * The lock itself is the database's (scripts/migrations/20260930-2000-suite-lock.sql, exercised against
 * the real sandbox database); these tests cover what this file owns: input shape, calling the right
 * database function with the right arguments, never mistaking a failure for "no suite needed", readable
 * error messages, and the address sync that never clobbers a hand-typed address.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = []
let rpcResult: { data: unknown; error: { message: string } | null } = { data: null, error: null }
let accountRow: { suite_number?: string | null; physical_address?: string | null } | null = null
let accountReadError: { message: string } | null = null
const accountUpdates: Array<Record<string, unknown>> = []

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      return Promise.resolve(rpcResult)
    },
    from: () => {
      const chain: Record<string, unknown> = {}
      let isUpdate = false
      Object.assign(chain, {
        select: () => chain,
        update: (payload: Record<string, unknown>) => {
          isUpdate = true
          accountUpdates.push(payload)
          return chain
        },
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: accountRow, error: accountReadError }),
        then: (resolve: (v: unknown) => unknown) => resolve(isUpdate ? { data: null, error: null } : { data: accountRow, error: accountReadError }),
      })
      return chain
    },
  },
}))

import {
  normalizeSuiteNumber,
  suiteNumericPart,
  largoAddressForSuite,
  getCompanySuite,
  companyCmraAddressLine,
  allocateCompanySuite,
  releaseSuiteReservation,
  assignSpecificCompanySuite,
  adminChangeCompanySuite,
  adminDeleteLease,
  syncPhysicalAddressToSuite,
  getSuiteStepState,
  issueSuiteForDelivery,
  waiveSuiteForDelivery,
  unwaiveSuiteForDelivery,
  claimCompanySuite,
  releaseCompanySuiteIfFree,
  releaseEndedSuites,
} from "@/lib/operations/suite"

beforeEach(() => {
  rpcCalls = []
  rpcResult = { data: null, error: null }
  accountRow = null
  accountReadError = null
  accountUpdates.length = 0
})

describe("suite format helpers", () => {
  it("normalises what staff type into 3D-NNN", () => {
    expect(normalizeSuiteNumber("3D-318")).toBe("3D-318")
    expect(normalizeSuiteNumber("3d318")).toBe("3D-318")
    expect(normalizeSuiteNumber(" Suite 3D-318 ")).toBe("3D-318")
    expect(normalizeSuiteNumber("3D 205")).toBe("3D-205")
    expect(normalizeSuiteNumber("3D-0318")).toBe("3D-318")
  })
  it("rejects anything that is not a numbered TD suite", () => {
    for (const bad of ["", "3D", "Suite 104-153", "3D-1", "318", null, undefined]) {
      expect(normalizeSuiteNumber(bad as string | null | undefined)).toBeNull()
    }
  })
  it("reads the numeric part of a suite", () => {
    expect(suiteNumericPart("3D-318")).toBe(318)
    expect(suiteNumericPart(" 3d-1000 ")).toBe(1000)
    expect(suiteNumericPart("Suite 3D-318")).toBeNull()
    expect(suiteNumericPart(null)).toBeNull()
  })
  it("builds the Largo address for a suite", () => {
    expect(largoAddressForSuite("3D-318")).toBe("10225 Ulmerton Rd, Suite 3D-318, Largo, FL 33771")
  })
})

describe("getCompanySuite", () => {
  it("returns the company's suite", async () => {
    accountRow = { suite_number: "3D-318" }
    expect(await getCompanySuite("a1")).toBe("3D-318")
  })
  it("returns null when the company has none, or a malformed value", async () => {
    accountRow = { suite_number: null }
    expect(await getCompanySuite("a1")).toBeNull()
    accountRow = { suite_number: "TBD" }
    expect(await getCompanySuite("a1")).toBeNull()
  })
  it("throws on a read error — a failed read is never 'no suite'", async () => {
    accountReadError = { message: "timeout" }
    await expect(getCompanySuite("a1")).rejects.toThrow("Could not read the company's suite")
  })
})

describe("companyCmraAddressLine — what the Operating Agreement prints", () => {
  const FALLBACK = "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771"
  it("is ALWAYS Largo + the company's own suite when it has one", async () => {
    accountRow = { suite_number: "3D-318" }
    expect(await companyCmraAddressLine("a1", "99 Old St, Town")).toBe("10225 Ulmerton Rd, Suite 3D-318, Largo, FL 33771")
  })
  it("uses the caller's fallback when the company has no suite yet", async () => {
    accountRow = { suite_number: null }
    expect(await companyCmraAddressLine("a1", FALLBACK)).toBe(FALLBACK)
  })
  it("a failed read never blocks the document — it falls back", async () => {
    accountReadError = { message: "timeout" }
    expect(await companyCmraAddressLine("a1", FALLBACK)).toBe(FALLBACK)
  })
})

describe("allocateCompanySuite", () => {
  it("calls the allocator with the company and/or delivery and returns the suite", async () => {
    rpcResult = { data: "3D-320", error: null }
    const suite = await allocateCompanySuite({ accountId: "a1", deliveryId: "d1", actor: "test" })
    expect(suite).toBe("3D-320")
    expect(rpcCalls).toEqual([{ fn: "allocate_company_suite", args: { p_account_id: "a1", p_delivery_id: "d1", p_actor: "test" } }])
  })
  it("a formation with no company yet reserves on the delivery (account null)", async () => {
    rpcResult = { data: "3D-321", error: null }
    await allocateCompanySuite({ deliveryId: "d9" })
    expect(rpcCalls[0].args).toEqual({ p_account_id: null, p_delivery_id: "d9", p_actor: "system" })
  })
  it("needs a company or a delivery", async () => {
    await expect(allocateCompanySuite({})).rejects.toThrow("needs an accountId or a deliveryId")
    expect(rpcCalls).toHaveLength(0)
  })
  it("throws (never returns a fake suite) when the database errors or returns nothing", async () => {
    rpcResult = { data: null, error: { message: "boom" } }
    await expect(allocateCompanySuite({ accountId: "a1" })).rejects.toThrow("Could not issue a suite")
    rpcResult = { data: null, error: null }
    await expect(allocateCompanySuite({ accountId: "a1" })).rejects.toThrow("Could not issue a suite")
  })
})

describe("the other database calls", () => {
  it("releases a reservation and returns the freed number (or null)", async () => {
    rpcResult = { data: "3D-330", error: null }
    expect(await releaseSuiteReservation("d1", "t")).toBe("3D-330")
    expect(rpcCalls[0]).toEqual({ fn: "release_suite_reservation", args: { p_delivery_id: "d1", p_actor: "t" } })
    rpcResult = { data: null, error: null }
    expect(await releaseSuiteReservation("d2")).toBeNull()
  })

  it("assigns a specific suite only when it is well-formed, normalised first", async () => {
    rpcResult = { data: "3D-318", error: null }
    expect(await assignSpecificCompanySuite("a1", "3d318", "t")).toBe("3D-318")
    expect(rpcCalls[0].args).toEqual({ p_account_id: "a1", p_suite: "3D-318", p_actor: "t" })
    await expect(assignSpecificCompanySuite("a1", "318")).rejects.toThrow("not a valid suite")
  })

  it("turns a database lock message into something readable", async () => {
    rpcResult = {
      data: null,
      error: { message: 'error: Suite 3D-318 already belongs to another company CONTEXT: PL/pgSQL function x' },
    }
    await expect(assignSpecificCompanySuite("a1", "3D-318")).rejects.toThrow(/^Suite 3D-318 already belongs to another company/)
  })

  it("admin change needs a valid suite (or null to release) and passes the reason and actor", async () => {
    rpcResult = { data: { changed: true, old: "3D-1xx", new: "3D-400", signed_leases_to_replace: 1 }, error: null }
    const res = await adminChangeCompanySuite({ accountId: "a1", newSuite: "3d400", reason: "moved", actor: "owner" })
    expect(res.signed_leases_to_replace).toBe(1)
    expect(rpcCalls[0]).toEqual({
      fn: "admin_change_company_suite",
      args: { p_account_id: "a1", p_new_suite: "3D-400", p_reason: "moved", p_actor: "owner" },
    })
    await adminChangeCompanySuite({ accountId: "a1", newSuite: null, reason: "release", actor: "owner" })
    expect(rpcCalls[1].args.p_new_suite).toBeNull()
    await expect(
      adminChangeCompanySuite({ accountId: "a1", newSuite: "nonsense", reason: "x", actor: "owner" }),
    ).rejects.toThrow("not a valid suite")
  })

  it("admin delete lease passes the reason and actor and returns what was deleted", async () => {
    rpcResult = { data: { deleted: true, status: "signed", suite: "3D-112", account_id: "a1", token: "t-2026" }, error: null }
    const res = await adminDeleteLease({ leaseId: "l1", reason: "personal lease", actor: "owner" })
    expect(res.deleted).toBe(true)
    expect(rpcCalls[0]).toEqual({ fn: "admin_delete_lease", args: { p_lease_id: "l1", p_reason: "personal lease", p_actor: "owner" } })
  })
})

describe("syncPhysicalAddressToSuite", () => {
  it("writes the Largo address when the account has none", async () => {
    accountRow = { physical_address: null }
    await syncPhysicalAddressToSuite("a1", "3D-318")
    expect(accountUpdates).toEqual([{ physical_address: "10225 Ulmerton Rd, Suite 3D-318, Largo, FL 33771" }])
  })
  it("refreshes an address our own lease flow wrote before", async () => {
    accountRow = { physical_address: "10225 Ulmerton Rd, Suite 3D-205, Largo, FL 33771" }
    await syncPhysicalAddressToSuite("a1", "3D-318")
    expect(accountUpdates).toHaveLength(1)
  })
  it("never clobbers a hand-typed address", async () => {
    accountRow = { physical_address: "123 Main St, Someplace, TX 75001" }
    await syncPhysicalAddressToSuite("a1", "3D-318")
    expect(accountUpdates).toHaveLength(0)
  })
  it("never throws", async () => {
    accountReadError = { message: "down" }
    accountRow = null
    await expect(syncPhysicalAddressToSuite("a1", "3D-318")).resolves.toBeUndefined()
  })
})

describe("the required Suite step (workspace)", () => {
  it("reads the state of the step for a delivery", async () => {
    rpcResult = { data: { delivery_id: "d1", satisfied: false, waived: false, account_suite: null, reserved_suite: null }, error: null }
    const st = await getSuiteStepState("d1")
    expect(st.satisfied).toBe(false)
    expect(rpcCalls[0]).toEqual({ fn: "suite_step_state", args: { p_delivery: "d1" } })
  })
  it("a failed read throws — it is never mistaken for 'not needed'", async () => {
    rpcResult = { data: null, error: { message: "timeout" } }
    await expect(getSuiteStepState("d1")).rejects.toThrow("Could not read the suite step")
    rpcResult = { data: null, error: null }
    await expect(getSuiteStepState("d1")).rejects.toThrow("Could not read the suite step")
  })
  it("Issue suite calls the database function and returns the suite", async () => {
    rpcResult = { data: "3D-330", error: null }
    expect(await issueSuiteForDelivery("d1", "dashboard:luca")).toBe("3D-330")
    expect(rpcCalls[0]).toEqual({ fn: "issue_delivery_suite", args: { p_delivery: "d1", p_actor: "dashboard:luca" } })
  })
  it("Issue suite surfaces the database's refusal", async () => {
    rpcResult = { data: null, error: { message: "error: Suite 3D-330 already belongs to another company CONTEXT: x" } }
    await expect(issueSuiteForDelivery("d1")).rejects.toThrow(/^Suite 3D-330 already belongs to another company/)
  })
  it("the waiver needs a reason and is trimmed; nothing is called without one", async () => {
    await expect(waiveSuiteForDelivery("d1", "   ")).rejects.toThrow("A reason is required")
    expect(rpcCalls).toHaveLength(0)
    rpcResult = { data: { waived: true }, error: null }
    await waiveSuiteForDelivery("d1", "  one-time customer ", "dashboard:antonio")
    expect(rpcCalls[0]).toEqual({ fn: "waive_delivery_suite", args: { p_delivery: "d1", p_reason: "one-time customer", p_actor: "dashboard:antonio" } })
  })
  it("a waiver the company already has a suite for is refused with the database's words", async () => {
    rpcResult = { data: null, error: { message: "This company already has suite 3D-311 — there is nothing to waive." } }
    await expect(waiveSuiteForDelivery("d1", "x")).rejects.toThrow("nothing to waive")
  })
  it("removes a waiver", async () => {
    rpcResult = { data: true, error: null }
    await unwaiveSuiteForDelivery("d1", "t")
    expect(rpcCalls[0]).toEqual({ fn: "unwaive_delivery_suite", args: { p_delivery: "d1", p_actor: "t" } })
  })
  it("claim-only returns the claimed suite, or null when nothing was reserved (it never issues)", async () => {
    rpcResult = { data: "3D-305", error: null }
    expect(await claimCompanySuite("a1", "d1", "t")).toBe("3D-305")
    expect(rpcCalls[0]).toEqual({ fn: "claim_company_suite", args: { p_account: "a1", p_delivery: "d1", p_actor: "t" } })
    rpcResult = { data: null, error: null }
    expect(await claimCompanySuite("a1", null)).toBeNull()
  })
})

describe("releasing a closed company's suite back to the pool", () => {
  it("releaseCompanySuiteIfFree returns the released suite, or null when nothing was free to release", async () => {
    rpcResult = { data: "3D-106", error: null }
    expect(await releaseCompanySuiteIfFree("a1", "lease ended", "tester")).toBe("3D-106")
    expect(rpcCalls[0]).toEqual({ fn: "release_company_suite_if_free", args: { p_account: "a1", p_reason: "lease ended", p_actor: "tester" } })
    rpcResult = { data: null, error: null }
    expect(await releaseCompanySuiteIfFree("a1")).toBeNull()
  })
  it("the daily sweep returns how many suites it released", async () => {
    rpcResult = { data: 3, error: null }
    expect(await releaseEndedSuites("cron")).toBe(3)
    expect(rpcCalls[0]).toEqual({ fn: "release_ended_suites", args: { p_actor: "cron" } })
  })
  it("a failed sweep throws (the cron reports the error), never pretends nothing was due", async () => {
    rpcResult = { data: null, error: { message: "permission denied" } }
    await expect(releaseEndedSuites()).rejects.toThrow("Could not release ended suites")
  })
})
