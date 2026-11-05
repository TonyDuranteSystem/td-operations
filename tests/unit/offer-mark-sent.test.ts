/**
 * Send's last write (lib/offers/mark-sent.ts, offer builder Part 3 item A): the offer is flipped to "sent" only if it is still
 * a draft, and a failed or skipped write is visible (it throws).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  result: { data: [{ token: "t1" }], error: null } as { data: unknown; error: null | { message: string } },
  calls: [] as Array<[string, ...unknown[]]>,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      h.calls.push(["from", table])
      const chain: Record<string, unknown> = {
        update: (patch: unknown) => { h.calls.push(["update", patch]); return chain },
        eq: (col: string, val: unknown) => { h.calls.push(["eq", col, val]); return chain },
        select: (cols: string) => { h.calls.push(["select", cols]); return Promise.resolve(h.result) },
      }
      return chain
    },
  },
}))

import { markOfferSent } from "@/lib/offers/mark-sent"

beforeEach(() => {
  h.result = { data: [{ token: "t1" }], error: null }
  h.calls = []
})

describe("markOfferSent", () => {
  it("flips ONLY a draft: the update is filtered on the token AND on status = draft", async () => {
    await markOfferSent("t1")
    expect(h.calls).toContainEqual(["update", { status: "sent", send_started_at: null }])
    expect(h.calls).toContainEqual(["eq", "token", "t1"])
    expect(h.calls).toContainEqual(["eq", "status", "draft"])
    expect(h.calls).toContainEqual(["from", "offers"])
  })

  it("clears the send claim in the same write (the offer is not left \"being sent\")", async () => {
    await markOfferSent("t1")
    const updates = h.calls.filter((c) => c[0] === "update")
    expect(updates).toHaveLength(1)
    expect(updates[0][1]).toMatchObject({ send_started_at: null })
  })

  it("asks for the changed rows back, so a skipped write can be seen", async () => {
    await markOfferSent("t1")
    expect(h.calls).toContainEqual(["select", "token"])
  })

  it("resolves when exactly the draft was flipped", async () => {
    await expect(markOfferSent("t1")).resolves.toBeUndefined()
  })

  it("throws when nothing was flipped (the offer was no longer a draft): the status is left alone and the reason is plain", async () => {
    h.result = { data: [], error: null }
    await expect(markOfferSent("t1")).rejects.toThrow("no longer a draft")
    h.result = { data: null, error: null }
    await expect(markOfferSent("t1")).rejects.toThrow("no longer a draft")
  })

  it("throws, with the database's words, when the write failed", async () => {
    h.result = { data: null, error: { message: "connection reset" } }
    await expect(markOfferSent("t1")).rejects.toThrow("could not mark the offer as sent (connection reset)")
  })
})
