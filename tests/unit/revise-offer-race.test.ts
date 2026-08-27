/**
 * /api/crm/admin-actions/revise-offer — the race-safety fix.
 *
 * Council QA (dev job 3c1bb5fa follow-up, bug-hunter major): the route used
 * to read the original offer once, build the v2 draft from that single
 * snapshot, then mark the original 'superseded' unconditionally. If a
 * client's pick (or signature) landed on the original in between, v2 was
 * built from stale data and the original — which by then held the client's
 * real, just-committed choice — got buried underneath it with no error to
 * either side. The fix ties the "mark superseded" write to the exact status
 * and pick-lock state the route read, so a change in between makes that
 * write match zero rows instead of silently succeeding.
 *
 * Mocking strategy: a single per-table call log lets each test script what
 * each successive call against "offers" should return, in the order the
 * route actually issues them (original read, token-collision check, v2
 * insert, conditional supersede update, rollback delete if needed).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: "admin-1", email: "admin@tonydurante.us" } }, error: null }) },
  }),
}))
vi.mock("@/lib/permissions", () => ({ canPerform: () => true }))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: vi.fn() }))

const originalFixture = {
  token: "offer-1",
  status: "sent",
  version: 1,
  currency: "EUR",
  bank_details: {},
  lead_id: null,
  package_locked_at: null as string | null,
}

let supersedeCalls: Array<{ eqArgs: Array<[string, unknown]>; isArgs: Array<[string, unknown]> }> = []
let supersedeResult: { data: unknown; error: { message: string } | null } = { data: [{ token: "offer-1-v2" }], error: null }
let deleteCalledWith: string | null = null

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== "offers") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }
      }
      return {
        select: (cols: string) => ({
          eq: (_col: string, _val: string) => ({
            single: () =>
              // The initial "fetch the original" read (select("*")) vs the
              // token-collision probe (select("token")) are told apart by
              // which columns were asked for.
              Promise.resolve(
                cols === "*"
                  ? { data: originalFixture, error: null }
                  : { data: null, error: { message: "not found" } },
              ),
            maybeSingle: () => Promise.resolve({ data: null, error: null }), // token collision: none
          }),
        }),
        insert: () => ({
          select: () => ({ single: () => Promise.resolve({ data: { token: "offer-1-v2" }, error: null }) }),
        }),
        update: () => {
          const call = { eqArgs: [] as Array<[string, unknown]>, isArgs: [] as Array<[string, unknown]> }
          const chain: Record<string, unknown> = {}
          chain.eq = (col: string, val: unknown) => { call.eqArgs.push([col, val]); return chain }
          chain.is = (col: string, val: unknown) => { call.isArgs.push([col, val]); return chain }
          chain.select = () => { supersedeCalls.push(call); return Promise.resolve(supersedeResult) }
          return chain
        },
        delete: () => ({
          eq: (_col: string, val: string) => { deleteCalledWith = val; return Promise.resolve({ data: null, error: null }) },
        }),
      }
    },
  },
}))

import { POST } from "@/app/api/crm/admin-actions/revise-offer/route"

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/crm/admin-actions/revise-offer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("revise-offer — race guard on the supersede write", () => {
  beforeEach(() => {
    supersedeCalls = []
    supersedeResult = { data: [{ token: "offer-1-v2" }], error: null }
    deleteCalledWith = null
    originalFixture.package_locked_at = null
  })

  it("ties the supersede write to the exact status and pick-lock state it read", async () => {
    const res = await POST(makeRequest({ offer_token: "offer-1" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    expect(supersedeCalls).toHaveLength(1)
    expect(supersedeCalls[0].eqArgs).toContainEqual(["status", "sent"])
    // package_locked_at was null at read time, so the guard checks IS NULL.
    expect(supersedeCalls[0].isArgs).toContainEqual(["package_locked_at", null])
  })

  it("refuses and rolls back the v2 draft when the original changed between the read and the write", async () => {
    // Simulates a client's pick or signature landing on the original in the
    // gap between this route's read and its supersede write: the guarded
    // UPDATE matches zero rows.
    supersedeResult = { data: [], error: null }

    const res = await POST(makeRequest({ offer_token: "offer-1" }) as Parameters<typeof POST>[0])

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/changed right as the revision was being created/)
    // The v2 draft that was already inserted must not be left as a stray,
    // half-committed row.
    expect(deleteCalledWith).toBe("offer-1-v2")
  })

  it("⛔ a real DB error on the supersede write must NEVER be reported as the race message (the exact conflation that hid the missing-'superseded'-in-the-CHECK-constraint bug for months)", async () => {
    // supabase-js returns { data: null, error: {...} } on a genuine failure — it does
    // NOT throw, and a bare zero-rows check cannot tell this apart from the legitimate
    // race case above unless the error field is inspected first.
    supersedeResult = { data: null, error: { message: 'new row for relation "offers" violates check constraint "offers_status_check"' } }

    const res = await POST(makeRequest({ offer_token: "offer-1" }) as Parameters<typeof POST>[0])

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/Could not mark the original offer as superseded/)
    expect(body.error).toMatch(/offers_status_check/)
    expect(body.error).not.toMatch(/changed right as the revision was being created/)
    // Still rolls back the orphaned v2 draft, same as the race case.
    expect(deleteCalledWith).toBe("offer-1-v2")
  })
})
