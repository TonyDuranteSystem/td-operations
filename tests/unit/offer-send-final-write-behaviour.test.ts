/**
 * Send, run through to its last step with a faked database and a faked email (offer builder Part 3 item A, dev job d2971d11).
 * What the real publishOffer does AFTER the email has gone out: flip the offer to "sent" only if it is still a draft, move the
 * lead only when the offer moved, and never hide a step that failed. Nothing real is sent or written.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

type Rows = { data: unknown; error: null | { message: string } }
const h = vi.hoisted(() => ({
  offer: null as Record<string, unknown> | null,
  flip: { data: [{ token: "t1" }], error: null } as Rows, // result of: offers.update(...).eq(token).eq(status, draft).select(token)
  calls: [] as Array<{ table: string; op: string; args: unknown[] }>,
  gmail: vi.fn(),
  logged: [] as Array<Record<string, unknown>>,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let op = "select"
      const eqs: Array<[string, unknown]> = []
      const chain: Record<string, unknown> = {
        select: () => (op === "update" ? Promise.resolve(table === "offers" ? h.flip : { data: null, error: null }) : chain),
        update: (patch: unknown) => { op = "update"; h.calls.push({ table, op, args: [patch, eqs] }); return chain },
        insert: (row: unknown) => { h.calls.push({ table, op: "insert", args: [row] }); return Promise.resolve({ data: null, error: null }) },
        eq: (col: string, val: unknown) => { eqs.push([col, val]); return op === "update" && table !== "offers" ? Promise.resolve({ data: null, error: null }) : chain },
        limit: () => chain,
        single: () => Promise.resolve({ data: h.offer, error: null }),
        maybeSingle: () => Promise.resolve({ data: { id: "contact-1" }, error: null }),
      }
      return chain
    },
  },
}))
vi.mock("@/lib/offers/send-claim", () => ({ claimOfferSend: vi.fn(async () => ({ ok: true, claimedAt: "2026-01-01T00:00:00.000Z" })), releaseOfferSend: vi.fn(async () => {}) }))
vi.mock("@/lib/offers/send-check", () => ({ offerSendCheck: vi.fn(async () => ({ blockers: [], risks: [], notChecked: [], willSendTo: "client@example.invalid" })) }))
vi.mock("@/lib/portal/auto-create", () => ({ autoCreatePortalUser: vi.fn(async () => ({ success: true, alreadyExists: true })) }))
vi.mock("@/lib/portal/welcome-token", () => ({ createWelcomeToken: vi.fn(), findWelcomeTokenBySource: vi.fn() }))
vi.mock("@/lib/auth-admin-helpers", () => ({ findAuthUserByEmail: vi.fn() }))
vi.mock("@/lib/gmail", () => ({ gmailPost: (...a: unknown[]) => h.gmail(...a) }))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: (e: Record<string, unknown>) => { h.logged.push(e) } }))

import { publishOffer } from "@/lib/offers/publish"

const OFFER = {
  id: "o1", token: "t1", client_name: "Test Client", client_email: "client@example.invalid", language: "en", status: "draft",
  access_code: "x", lead_id: "lead-1", account_id: null, services: [], bundled_pipelines: [], recurring_costs: null, installment_currency: null, contract_type: "tax_return",
}
const offerWrites = () => h.calls.filter((c) => c.table === "offers" && c.op === "update")
const leadWrites = () => h.calls.filter((c) => c.table === "leads" && c.op === "update")

beforeEach(() => {
  h.offer = { ...OFFER }
  h.flip = { data: [{ token: "t1" }], error: null }
  h.calls = []
  h.logged = []
  h.gmail.mockReset()
  h.gmail.mockResolvedValue({ id: "gmail-1", threadId: "thread-1" })
})

describe("Send, after the email has gone out", () => {
  it("the normal case: the draft is flipped to sent (only if still a draft), the lead moves, no warnings", async () => {
    const r = await publishOffer("t1", "test")
    expect(r.success).toBe(true)
    expect(r.warnings).toEqual([])
    expect(h.gmail).toHaveBeenCalledTimes(1)
    const [flip] = offerWrites()
    expect(flip.args[0]).toEqual({ status: "sent", send_started_at: null })
    expect(flip.args[1]).toEqual([["token", "t1"], ["status", "draft"]])
    expect(leadWrites()).toHaveLength(1)
    expect(leadWrites()[0].args[0]).toEqual({ offer_status: "Sent", status: "Offer Sent" })
  })

  it("the offer was no longer a draft when the email went out: its status is NOT overwritten, the lead does NOT move, and it says so", async () => {
    h.flip = { data: [], error: null }
    const r = await publishOffer("t1", "test")
    expect(r.success).toBe(true) // the email did go out; the caller must still be told
    expect(r.warnings.join(" ")).toContain("update_offer_status")
    expect(r.warnings.join(" ")).toContain("no longer a draft")
    expect(leadWrites()).toHaveLength(0)
    expect(h.logged[0]?.details).toMatchObject({ warnings: expect.any(Array) })
  })

  it("the status write failed: nothing is hidden, the lead does not move", async () => {
    h.flip = { data: null, error: { message: "connection reset" } }
    const r = await publishOffer("t1", "test")
    expect(r.success).toBe(true)
    expect(r.warnings.join(" ")).toContain("could not mark the offer as sent (connection reset)")
    expect(leadWrites()).toHaveLength(0)
  })

  it("an offer that is not a draft at the start is still refused before anything is sent", async () => {
    h.offer = { ...OFFER, status: "sent" }
    const r = await publishOffer("t1", "test")
    expect(r.success).toBe(false)
    expect(r.alreadySent).toBe(true)
    expect(h.gmail).not.toHaveBeenCalled()
    expect(offerWrites()).toHaveLength(0)
  })

  it("a failed email changes nothing at all (the old rule: never mark sent when the email failed)", async () => {
    h.gmail.mockRejectedValue(new Error("gmail down"))
    await expect(publishOffer("t1", "test")).rejects.toThrow("gmail down")
    expect(offerWrites()).toHaveLength(0)
    expect(leadWrites()).toHaveLength(0)
  })
})
