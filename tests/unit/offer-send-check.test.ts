/**
 * Offer builder Part 1 — the ONE function that decides "can this offer be sent?" (lib/offers/send-check.ts).
 * The REAL-send answers (order, words, one problem at a time) are frozen in offer-send-gate-parity.test.ts and
 * offer-activate-lead-gate-parity.test.ts. This file covers what is new: the read-only "preview" mode the box beside the
 * Send buttons uses — every step runs, nothing is written, a lookup that failed is listed as "not checked" (never
 * as a blocker, never as "fine"), and risks are warnings that never block.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

type Res = { data: unknown; error: { message: string } | null }
interface Chain {
  select: () => Chain
  eq: () => Chain
  in: () => Chain
  single: () => Promise<Res>
  maybeSingle: () => Promise<Res>
  then: (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>
}

const h = vi.hoisted(() => ({
  packages: { data: { packages: null }, error: null } as Res,
  annual: { data: [], error: null } as Res,
  catalog: { data: [], error: null } as Res,
  stages: { data: [], error: null } as Res,
  texts: { data: [], error: null } as Res,
  ensure: vi.fn(),
  multi: false,
  multiThrows: false,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string): Chain => {
      const pick = (): Res =>
        table === "service_catalog" ? h.annual
        : table === "catalog_entries" ? h.catalog
        : table === "pipeline_stages" ? h.stages
        : table === "service_contract_texts" ? h.texts
        : { data: null, error: null }
      const chain: Chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        single: () => Promise.resolve({ data: null, error: null }),
        maybeSingle: () => Promise.resolve(h.packages),
        then: (resolve, reject) => Promise.resolve(pick()).then(resolve, reject),
      }
      return chain
    },
  },
}))
vi.mock("@/lib/offers/contract-texts-snapshot", () => ({ ensureOfferContractTexts: (...a: unknown[]) => h.ensure(...a) }))
vi.mock("@/lib/offers/multi-agreements-switch", () => ({
  multiAgreementsEnabled: async () => {
    if (h.multiThrows) throw new Error("switch unreadable")
    return h.multi
  },
}))

import { offerSendCheck, type OfferForSendCheck } from "@/lib/offers/send-check"

const offer = (over: Partial<OfferForSendCheck> = {}): OfferForSendCheck => ({
  token: "tok-1",
  status: "draft",
  client_email: "jane@example.com",
  services: [{ name: "Tax Return", price: "$500" }],
  bundled_pipelines: null,
  recurring_costs: null,
  installment_currency: null,
  contract_type: "tax_return",
  ...over,
})
const apostilleLines = [{ name: "Apostille", price: "$100", pipeline_type: "Apostille" }]
const formation = [{ name: "Formation", price: "$2,000", pipeline_type: "Company Formation" }]
const PORTAL_NOTE = "The client's portal login is created at the moment you send, so it cannot be checked in advance."

beforeEach(() => {
  h.packages = { data: { packages: null }, error: null }
  h.annual = { data: [{ pipeline: "Company Formation" }], error: null }
  h.catalog = { data: [], error: null }
  h.stages = { data: [], error: null }
  h.texts = { data: [], error: null }
  h.multi = false
  h.multiThrows = false
  h.ensure.mockReset()
  h.ensure.mockResolvedValue({ texts: {}, missing: [], changed: false })
})

describe("offerSendCheck — preview mode (the read-only box)", () => {
  it("a clean offer: no blockers, says who it goes to, says what it could not check, writes nothing", async () => {
    const r = await offerSendCheck({ offer: offer(), door: "send", mode: "preview" })
    expect(r.blockers).toEqual([])
    expect(r.risks).toEqual([])
    expect(r.willSendTo).toBe("jane@example.com")
    expect(r.notChecked).toContain(PORTAL_NOTE)
    // the wording is worked out in memory: a fresh copy, nothing saved
    expect(h.ensure).toHaveBeenCalledWith("tok-1", { refresh: true, persist: false })
  })

  it("every problem is listed at once, in the order the real Send checks them", async () => {
    h.ensure.mockResolvedValue({ texts: {}, missing: ["Apostille"], changed: false })
    const r = await offerSendCheck({ offer: offer({ client_email: null, status: "sent", services: [...formation, ...apostilleLines] }), door: "send", mode: "preview" })
    expect(r.blockers.map((b) => b.step)).toEqual(["email", "yearly_fee", "status", "services", "wording"])
    expect(r.blockers[0].message).toBe("client_email is not set on this offer. Update it first.")
    expect(r.blockers[2].message).toBe("offer is in 'sent' status. Only 'draft' offers can be published.")
    expect(r.blockers[3].readiness?.map((b) => b.kind)).toEqual(["not_in_catalog"])
    expect(r.willSendTo).toBeNull()
  })

  it("the SAME offer on the real send stops at the first problem and never reaches the wording step that writes", async () => {
    h.ensure.mockResolvedValue({ texts: {}, missing: ["Apostille"], changed: false })
    const r = await offerSendCheck({ offer: offer({ client_email: null, status: "sent", services: [...formation, ...apostilleLines] }), door: "send", mode: "send" })
    expect(r.blockers.map((b) => b.step)).toEqual(["email"])
    expect(h.ensure).not.toHaveBeenCalled()
    expect(r.notChecked).toEqual([])
    expect(r.risks).toEqual([])
  })

  it("a lookup that failed is listed under 'not checked', not as a blocker and not as fine", async () => {
    h.annual = { data: null, error: { message: "db down" } }
    h.catalog = { data: null, error: { message: "catalog down" } }
    h.ensure.mockRejectedValue(new Error("store down"))
    const r = await offerSendCheck({ offer: offer({ services: [...formation, ...apostilleLines] }), door: "send", mode: "preview" })
    expect(r.blockers).toEqual([])
    expect(r.notChecked).toContain("Could not check whether this offer needs a yearly fee (db down) — try again.")
    expect(r.notChecked).toContain("Could not check the services on this offer (catalog down) — try again.")
    expect(r.notChecked).toContain("Could not read the contract wording (store down) — try again.")
    expect(r.notChecked).toContain(PORTAL_NOTE)
  })

  it("the same failed lookups on the real send are blockers marked 'could not check' (the send is refused)", async () => {
    h.annual = { data: null, error: { message: "db down" } }
    const r = await offerSendCheck({ offer: offer(), door: "send", mode: "send" })
    expect(r.blockers).toEqual([{ step: "yearly_fee", couldNotCheck: true, message: "could not check whether this offer needs a yearly fee (db down) — try again." }])
  })

  it("a failed package read is not checked in the box and refuses the real send", async () => {
    h.packages = { data: null, error: { message: "pk down" } }
    const preview = await offerSendCheck({ offer: offer(), door: "send", mode: "preview" })
    expect(preview.blockers).toEqual([])
    expect(preview.notChecked).toContain("Could not read the offer's packages (pk down) — try again.")
    const real = await offerSendCheck({ offer: offer(), door: "send", mode: "send" })
    expect(real.blockers[0]).toMatchObject({ step: "yearly_fee", couldNotCheck: true })
  })

  it("services saved with a name only are named under 'not checked' (the engine cannot judge them)", async () => {
    const r = await offerSendCheck({ offer: offer({ services: [{ name: "Notary stamp", price: "$20" }, { name: "Apostille", pipeline_type: "Apostille" }] }), door: "send", mode: "preview" })
    expect(r.notChecked.some((n) => n.includes('"Notary stamp" was saved with a name only'))).toBe(true)
    expect(r.notChecked.some((n) => n.includes('"Apostille" was saved with a name only'))).toBe(false)
  })

  it("services stored as text are said to be unchecked", async () => {
    const r = await offerSendCheck({ offer: offer({ services: '[{"name":"Apostille","pipeline_type":"Apostille"}]' }), door: "send", mode: "preview" })
    expect(r.notChecked).toContain("The services on this offer are stored as text, so none of them could be checked.")
  })
})

describe("offerSendCheck — risks (the box warns; nothing here ever blocks)", () => {
  const twoServices = [{ name: "Tax Return", price: "$500", contract_type: "tax_return" }, { name: "Consulting Call", price: "$300", contract_type: "consulting_call" }]

  it("two billed services with 'Several agreements in one contract' OFF: a risk row that says to sell it in its own offer", async () => {
    h.multi = false
    const r = await offerSendCheck({ offer: offer({ services: twoServices }), door: "send", mode: "preview" })
    expect(r.blockers).toEqual([])
    expect(r.risks).toHaveLength(1)
    expect(r.risks[0]).toContain('"Consulting Call"')
    expect(r.risks[0]).toContain("sell it in its own offer")
  })

  it("the same offer with the switch ON has no risk", async () => {
    h.multi = true
    const r = await offerSendCheck({ offer: offer({ services: twoServices }), door: "send", mode: "preview" })
    expect(r.risks).toEqual([])
  })

  it("a billed line with no contract of its own is a risk, still not a block", async () => {
    h.multi = true
    const r = await offerSendCheck({ offer: offer({ services: [{ name: "Tax Return", price: "$500", contract_type: "tax_return" }, { name: "Mystery Add-on", price: "$50" }] }), door: "send", mode: "preview" })
    expect(r.blockers).toEqual([])
    expect(r.risks[0]).toContain('"Mystery Add-on"')
    expect(r.risks[0]).toContain("no contract of its own")
  })

  it("if the switch cannot be read, that goes under 'not checked' (no risk is invented, no block)", async () => {
    h.multiThrows = true
    const r = await offerSendCheck({ offer: offer({ services: twoServices }), door: "send", mode: "preview" })
    expect(r.blockers).toEqual([])
    expect(r.risks).toEqual([])
    expect(r.notChecked).toContain("Whether every billed service appears in the client's contract could not be checked.")
  })

  it("the real send never computes risks", async () => {
    h.multi = false
    const r = await offerSendCheck({ offer: offer({ services: twoServices }), door: "send", mode: "send" })
    expect(r.risks).toEqual([])
  })
})
