/**
 * Claude's offer-edit tool (offer_update) run through its real handler with a faked database
 * (offer builder Part 3 item D, dev job d2971d11): an offer that is already out needs a written reason before anything is
 * changed, and the reason is logged. A draft is edited exactly as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  status: "draft" as string | null, // the offer's current status; null = no such offer
  writes: [] as unknown[],
  logged: [] as Array<Record<string, unknown>>,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      let updating = false
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (patch: unknown) => { updating = true; h.writes.push(patch); return chain },
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: h.status ? { status: h.status } : null, error: null }),
        single: () => Promise.resolve({ data: { token: "t1", client_name: "Test Client", status: h.status ?? "draft", language: "en", payment_type: "none" }, error: updating ? null : null }),
      }
      return chain
    },
  },
}))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: (e: Record<string, unknown>) => { h.logged.push(e) } }))

import { registerOfferTools } from "@/lib/mcp/tools/offers"

type Handler = (args: { token: string; updates: Record<string, unknown>; reason?: string }) => Promise<{ content: Array<{ text: string }> }>
const handlers: Record<string, Handler> = {}
registerOfferTools({ tool: (name: string, ...rest: unknown[]) => { handlers[name] = rest[rest.length - 1] as Handler } } as never)

const update = (args: { updates?: Record<string, unknown>; reason?: string } = {}) =>
  handlers.offer_update({ token: "t1", updates: args.updates ?? { currency: "USD" }, reason: args.reason })

beforeEach(() => {
  h.status = "draft"
  h.writes = []
  h.logged = []
})

describe("offer_update on a draft", () => {
  it("is edited exactly as before: no reason needed, nothing extra in the log", async () => {
    const r = await update()
    expect(r.content[0].text).toContain("Offer t1 updated")
    expect(h.writes).toEqual([{ currency: "USD" }])
    expect(h.logged[0].details).toEqual({ fields: ["currency"] })
  })
})

describe("offer_update on an offer that is already out", () => {
  it.each(["sent", "viewed", "signed", "completed"])("'%s' with NO reason: refused, nothing is written, Claude is told to ask Antonio first", async (status) => {
    h.status = status
    const r = await update()
    expect(r.content[0].text).toContain("offer_update refused")
    expect(r.content[0].text).toContain("Tell Antonio")
    expect(h.writes).toEqual([])
    expect(h.logged).toEqual([])
  })

  it("a reason that is too short is refused too", async () => {
    h.status = "sent"
    const r = await update({ reason: "fix it" })
    expect(r.content[0].text).toContain("offer_update refused")
    expect(h.writes).toEqual([])
  })

  it("with a real reason the edit goes ahead and the reason and the previous status are logged", async () => {
    h.status = "completed"
    const r = await update({ reason: "  Currency was typed as EUR at creation, the client agreed USD  " })
    expect(r.content[0].text).toContain("Offer t1 updated")
    expect(h.writes).toEqual([{ currency: "USD" }])
    expect(h.logged[0].details).toEqual({
      fields: ["currency"],
      previous_status: "completed",
      reason: "Currency was typed as EUR at creation, the client agreed USD",
    })
  })

  it("an offer that does not exist is left to the update to report (no reason demanded)", async () => {
    h.status = null
    const r = await update()
    expect(r.content[0].text).not.toContain("offer_update refused")
  })
})
