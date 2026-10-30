/**
 * GET /api/finance/same-amount-paid — the guards around the reader, not the reader itself (same-amount-paid.test.ts).
 * Break the sign-in check and the 401 test fails; let any days value through and the days test fails; send the
 * wrong owner flag and the privacy test fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

let user: { id: string } | null
let owner: boolean
const loadSameAmountPaid = vi.fn()

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user } }) } }),
}))
vi.mock("@/lib/auth", () => ({ isOwnerOnly: () => owner }))
vi.mock("@/lib/finance/same-amount-paid", () => ({ loadSameAmountPaid: (...a: unknown[]) => loadSameAmountPaid(...a) }))

import { GET } from "@/app/api/finance/same-amount-paid/route"

const FEED_ID = "228b5a19-9a35-4221-84bc-1226d4a605c0"
const get = (qs: string) => GET(new Request(`http://localhost/api/finance/same-amount-paid${qs}`))

beforeEach(() => {
  user = { id: "staff-1" }
  owner = false
  loadSameAmountPaid.mockReset()
  loadSameAmountPaid.mockResolvedValue({ ok: true, searched: true, days: 3, invoices: [], found: 0, already_tied: 0 })
})

describe("GET /api/finance/same-amount-paid", () => {
  it("401 when nobody is signed in — and nothing is read", async () => {
    user = null
    expect((await get(`?feed_id=${FEED_ID}`)).status).toBe(401)
    expect(loadSameAmountPaid).not.toHaveBeenCalled()
  })

  it("400 for something that is not a payment id", async () => {
    expect((await get("?feed_id=nope")).status).toBe(400)
    expect((await get("")).status).toBe(400)
    expect(loadSameAmountPaid).not.toHaveBeenCalled()
  })

  it("any signed-in staff member may ask, and the owner flag is passed on as it is", async () => {
    expect((await get(`?feed_id=${FEED_ID}`)).status).toBe(200)
    expect(loadSameAmountPaid).toHaveBeenLastCalledWith({ feedId: FEED_ID, days: null, isOwner: false })
    owner = true
    await get(`?feed_id=${FEED_ID}`)
    expect(loadSameAmountPaid).toHaveBeenLastCalledWith({ feedId: FEED_ID, days: null, isOwner: true })
  })

  it("passes the days asked for to the reader (which only ever honours 30, else 3)", async () => {
    await get(`?feed_id=${FEED_ID}&days=30`)
    expect(loadSameAmountPaid).toHaveBeenLastCalledWith({ feedId: FEED_ID, days: "30", isOwner: false })
  })

  it("returns the reader's answer as it is", async () => {
    loadSameAmountPaid.mockResolvedValue({ ok: true, searched: true, days: 3, invoices: [{ id: "a" }], found: 1, already_tied: 2 })
    const body = await (await get(`?feed_id=${FEED_ID}`)).json()
    expect(body).toMatchObject({ ok: true, found: 1, already_tied: 2, invoices: [{ id: "a" }] })
  })

  it("404 when the payment is not found (or private to the owner), 500 with the plain reason otherwise", async () => {
    loadSameAmountPaid.mockResolvedValue({ ok: false, error: "Transaction not found." })
    expect((await get(`?feed_id=${FEED_ID}`)).status).toBe(404)
    loadSameAmountPaid.mockResolvedValue({ ok: false, error: "Could not read the paid invoices." })
    const res = await get(`?feed_id=${FEED_ID}`)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Could not read the paid invoices.")
  })
})
