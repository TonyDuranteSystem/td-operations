import { describe, it, expect, vi, beforeEach } from "vitest"

/** Exactly-once sending of a Draft (dev job ae3c19db): only the click that wins the claim emails the client. */
const log: Array<{ method: string; args: unknown[] }> = []
let result: { data: Array<{ id: string }> | null; error: { message: string } | null } = { data: [{ id: "p1" }], error: null }

vi.mock("@/lib/supabase-admin", () => {
  const chain: Record<string, unknown> = {}
  for (const m of ["update", "eq", "or", "select"]) chain[m] = (...args: unknown[]) => { log.push({ method: m, args }); return chain }
  chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej)
  return { supabaseAdmin: { from: () => chain } }
})

import { claimInvoiceSend, releaseInvoiceSendClaim, SEND_CLAIM_STALE_MS } from "@/lib/operations/invoice-send-claim"

beforeEach(() => { log.length = 0; result = { data: [{ id: "p1" }], error: null }; vi.restoreAllMocks() })

describe("claimInvoiceSend", () => {
  it("stamps sent_at on THIS payment, only while it is still a Draft whose stamp is empty or stale", async () => {
    expect(await claimInvoiceSend("p1")).toBe(true)
    expect(log.find((l) => l.method === "update")?.args[0]).toMatchObject({ sent_at: expect.any(String) })
    expect(log.filter((l) => l.method === "eq").map((l) => l.args)).toEqual([["id", "p1"], ["invoice_status", "Draft"]])
    const or = String(log.find((l) => l.method === "or")?.args[0])
    expect(or).toMatch(/^sent_at\.is\.null,sent_at\.lt\.\d{4}-\d{2}-\d{2}T/)
  })
  it("the stale cut-off is a few minutes back (a server that died mid-send must not block the invoice for ever)", async () => {
    const before = Date.now()
    await claimInvoiceSend("p1")
    const cut = Date.parse(String(log.find((l) => l.method === "or")?.args[0]).split("sent_at.lt.")[1])
    expect(before - cut).toBeGreaterThanOrEqual(SEND_CLAIM_STALE_MS - 1000)
    expect(before - cut).toBeLessThan(SEND_CLAIM_STALE_MS + 5000)
  })
  it("loses (false) when no row came back: someone else holds the claim or already sent it", async () => {
    result = { data: [], error: null }
    expect(await claimInvoiceSend("p1")).toBe(false)
    result = { data: null, error: null }
    expect(await claimInvoiceSend("p1")).toBe(false)
  })
  it("throws on a database error, so the caller can say the invoice exists but was not sent", async () => {
    result = { data: null, error: { message: "db down" } }
    await expect(claimInvoiceSend("p1")).rejects.toThrow("db down")
  })
})

describe("releaseInvoiceSendClaim", () => {
  it("clears the stamp on a still-unsent Draft", async () => {
    await releaseInvoiceSendClaim("p1")
    expect(log.find((l) => l.method === "update")?.args[0]).toEqual({ sent_at: null })
    expect(log.filter((l) => l.method === "eq").map((l) => l.args)).toEqual([["id", "p1"], ["invoice_status", "Draft"]])
  })
  it("never throws: a failed release is logged only", async () => {
    result = { data: null, error: { message: "db down" } }
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(releaseInvoiceSendClaim("p1")).resolves.toBeUndefined()
    expect(err).toHaveBeenCalled()
  })
})
