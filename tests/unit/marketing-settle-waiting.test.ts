/**
 * Marketing settle (dev job ac893719): a payment that WAITS because the invoice-departments list is broken is not counted as a try (it must not park a paid
 * payment), but the reason is written on the Bank Feed row so a person who opens it can see why; it is not rewritten every run, and the matched write clears it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const updateFeed = vi.fn(async () => ({ ok: true }))
vi.mock("@/lib/finance/feed-write", () => ({ updateFeed: (...a: unknown[]) => (updateFeed as unknown as (...x: unknown[]) => unknown)(...a) }))
vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/marketing/meta-leads/service", () => ({ leadDb: () => ({}) }))
vi.mock("@/lib/marketing/sales-server", () => ({ recordPaidSession: vi.fn() }))
vi.mock("@/lib/invoices/departments", () => ({ INVOICE_ORIGINS: { marketingSale: "marketing_sale" }, departmentIdToStoreForOrigin: vi.fn() }))
vi.mock("@/lib/operations/paid-call-credit", () => ({ recordPaidCall: vi.fn() }))
vi.mock("@/lib/stripe-sync", () => ({ isChargeRefundedNow: vi.fn() }))
vi.mock("@/lib/system-errors", () => ({ reportSystemError: vi.fn() }))
vi.mock("@/lib/finance/feed-signals", () => ({ extractStripePaymentIntent: vi.fn() }))

import { failTry, MAX_SETTLE_TRIES } from "@/lib/finance/marketing-sale-settle"
import { readFileSync } from "node:fs"

describe("a waiting payment (count: false)", () => {
  beforeEach(() => updateFeed.mockClear())

  it("writes the reason on the row and does NOT count a try", async () => {
    const r = await failTry("f1", { review_metadata: null }, "list broken", { count: false })
    expect(r).toEqual({ matched: false, error: "list broken" })
    expect(updateFeed).toHaveBeenCalledTimes(1)
    const [id, patch] = updateFeed.mock.calls[0] as unknown as [string, { review_metadata: Record<string, unknown> }]
    expect(id).toBe("f1")
    expect(patch.review_metadata.marketing_settle_waiting).toMatchObject({ reason: "list broken" })
    expect("marketing_settle_tries" in patch.review_metadata).toBe(false)
  })

  it("never parks, however many times it waits (even with the tries already at the limit)", async () => {
    const feed = { review_metadata: { marketing_settle_tries: MAX_SETTLE_TRIES - 1 } }
    const r = await failTry("f1", feed, "list broken", { count: false })
    expect(r.matched).toBe(false)
    expect("parked" in r).toBe(false)
    const patch = (updateFeed.mock.calls[0] as unknown as [string, { status?: string }])[1]
    expect(patch.status).toBeUndefined()
  })

  it("does not write again when the row already says the same thing (it runs every few minutes)", async () => {
    await failTry("f1", { review_metadata: { marketing_settle_waiting: { reason: "list broken", at: "2026-11-05T10:00:00Z" } } }, "list broken", { count: false })
    expect(updateFeed).not.toHaveBeenCalled()
  })

  it("writes again when the reason changed", async () => {
    await failTry("f1", { review_metadata: { marketing_settle_waiting: { reason: "old reason", at: "2026-11-05T10:00:00Z" } } }, "new reason", { count: false })
    expect(updateFeed).toHaveBeenCalledTimes(1)
  })

  it("a counted failure still counts and still parks at the limit (unchanged)", async () => {
    const r = await failTry("f1", { review_metadata: { marketing_settle_tries: MAX_SETTLE_TRIES - 1 } }, "boom")
    expect(r).toMatchObject({ matched: false, parked: true })
  })

  it("the matched write clears the waiting note, so a settled row never carries a stale reason", () => {
    const src = readFileSync("lib/finance/marketing-sale-settle.ts", "utf8")
    const matched = src.slice(src.indexOf('"marketing-sale:matched"') - 600, src.indexOf('"marketing-sale:matched"'))
    expect(matched).toMatch(/marketing_settle_waiting:\s*null/)
  })
})
