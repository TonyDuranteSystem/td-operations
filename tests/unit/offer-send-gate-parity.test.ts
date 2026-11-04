/**
 * Offer builder Part 1, step 1.1 — what the real SEND (publishOffer) answers today, frozen BEFORE the checks are moved
 * into one shared function (dev job d2971d11, plan "Offer Builder Plan v4 — ADDENDUM 1").
 *
 * Nothing here is a wish: each case records what the code under lib/offers/publish.ts answered when this file was written
 * (against main 8c2cd3d3c). The same table must keep passing after the refactor, so the refusals keep their exact words
 * and their order. The only deliberate changes are marked "DELIBERATE CHANGE" below.
 *
 * The database is faked. The run stops at the first thing that would really happen: creating the client's portal login
 * (mocked to fail with a sentinel). So "the check passed" = the sentinel answer came back, and nothing was sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

type Res = { data: unknown; error: { message: string } | null }
interface Chain {
  select: () => Chain
  eq: () => Chain
  in: () => Chain
  order: () => Chain
  limit: () => Chain
  single: () => Promise<Res>
  maybeSingle: () => Promise<Res>
  then: (resolve: (v: Res) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>
}

const h = vi.hoisted(() => ({
  offer: { data: null, error: null } as Res, // offers ... .single()        -> the offer row
  packages: { data: null, error: null } as Res, // offers ... .maybeSingle()  -> the packages read
  annual: { data: [], error: null } as Res, // service_catalog (has_annual)
  catalog: { data: [], error: null } as Res, // catalog_entries
  stages: { data: [], error: null } as Res, // pipeline_stages
  texts: { data: [], error: null } as Res, // service_contract_texts
  portal: vi.fn(),
  ensure: vi.fn(),
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
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve(h.offer),
        maybeSingle: () => Promise.resolve(h.packages),
        then: (resolve, reject) => Promise.resolve(pick()).then(resolve, reject),
      }
      return chain
    },
  },
}))
vi.mock("@/lib/gmail", () => ({ gmailPost: vi.fn() }))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: vi.fn() }))
vi.mock("@/lib/mcp/safe-send", () => ({ safeSend: vi.fn() }))
vi.mock("@/lib/portal/auto-create", () => ({ autoCreatePortalUser: (...a: unknown[]) => h.portal(...a) }))
vi.mock("@/lib/portal/welcome-token", () => ({ createWelcomeToken: vi.fn(), findWelcomeTokenBySource: vi.fn() }))
vi.mock("@/lib/auth-admin-helpers", () => ({ findAuthUserByEmail: vi.fn() }))
vi.mock("@/lib/email/open-pixel", () => ({ openPixelImg: vi.fn() }))
vi.mock("@/lib/config", () => ({ APP_BASE_URL: "https://app.example", PORTAL_BASE_URL: "https://portal.example" }))
vi.mock("@/lib/offers/contract-texts-snapshot", () => ({ ensureOfferContractTexts: (...a: unknown[]) => h.ensure(...a) }))

import { publishOffer } from "@/lib/offers/publish"

const TOKEN = "tok-1"
/** What publishOffer answers when every check passed: the next thing it does is create the portal login, which the test makes fail. */
const PASSED = "Portal user creation failed: SENTINEL. Offer NOT published."

const offerRow = (over: Record<string, unknown> = {}) => ({
  id: "o1",
  token: TOKEN,
  client_name: "Jane Doe",
  client_email: "jane@example.com",
  language: "en",
  status: "draft",
  access_code: null,
  lead_id: "l1",
  account_id: null,
  services: [{ name: "Tax Return", price: "$500" }],
  bundled_pipelines: null,
  recurring_costs: null,
  installment_currency: null,
  contract_type: "tax_return",
  ...over,
})

const apostille = (over: Record<string, unknown> = {}) => ({
  id: "e1",
  slug: "apostille",
  display_name: "Apostille",
  status: "active",
  metadata: { pipeline: "Apostille", contract_type: "shipping" },
  ...over,
})
const apostilleLines = [{ name: "Apostille", price: "$100", pipeline_type: "Apostille" }]

beforeEach(() => {
  h.offer = { data: offerRow(), error: null }
  h.packages = { data: { packages: null }, error: null }
  h.annual = { data: [{ pipeline: "Company Formation" }, { pipeline: "Client Onboarding" }], error: null }
  h.catalog = { data: [], error: null }
  h.stages = { data: [], error: null }
  h.texts = { data: [], error: null }
  h.portal.mockReset()
  h.portal.mockResolvedValue({ success: false, error: "SENTINEL" })
  h.ensure.mockReset()
  h.ensure.mockResolvedValue({ texts: {}, missing: [], changed: false })
})

const publish = () => publishOffer(TOKEN, "test")

describe("publishOffer — the order of the checks and the exact words of each refusal (frozen from today's code)", () => {
  it("an ordinary offer passes every check and goes on to create the portal login", async () => {
    const r = await publish()
    expect(r.success).toBe(false)
    expect(r.error).toBe(PASSED)
    expect(h.portal).toHaveBeenCalledTimes(1)
    // the wording is frozen for the real send: a fresh copy, written
    expect(h.ensure).toHaveBeenCalledWith(TOKEN, { refresh: true })
  })

  it("1. offer not found", async () => {
    h.offer = { data: null, error: { message: "no rows" } }
    const r = await publish()
    expect(r.error).toBe(`Offer not found: ${TOKEN}`)
    expect(h.portal).not.toHaveBeenCalled()
  })

  it("2. no client email", async () => {
    h.offer = { data: offerRow({ client_email: null }), error: null }
    const r = await publish()
    expect(r.error).toBe("Cannot publish: client_email is not set on this offer. Update it first.")
    expect(r.blockers).toBeUndefined()
    expect(h.portal).not.toHaveBeenCalled()
    expect(h.ensure).not.toHaveBeenCalled()
  })

  it("3. a formation offer with no yearly fee written down", async () => {
    h.offer = { data: offerRow({ services: [{ name: "Formation", price: "$2,000", pipeline_type: "Company Formation" }], recurring_costs: null }), error: null }
    const r = await publish()
    expect(r.error).toBe(
      "Cannot publish: This offer has no yearly fee. Enter the January and June amounts (Annual Rates) before sending — otherwise the offer and the contract show no yearly fee.",
    )
    expect(h.portal).not.toHaveBeenCalled()
  })

  it("3b. a multi-option offer is not asked for a yearly fee (each option carries its own)", async () => {
    h.offer = { data: offerRow({ services: [{ name: "Formation", price: "$2,000", pipeline_type: "Company Formation" }] }), error: null }
    h.packages = { data: { packages: [{ label: "A" }, { label: "B" }] }, error: null }
    expect((await publish()).error).toBe(PASSED)
  })

  it("4. not a draft", async () => {
    h.offer = { data: offerRow({ status: "sent" }), error: null }
    const r = await publish()
    expect(r.error).toBe("Cannot publish: offer is in 'sent' status. Only 'draft' offers can be published.")
    expect(r.alreadySent).toBe(false)
    expect(h.portal).not.toHaveBeenCalled()
  })

  it("order: no client email wins over a yearly fee problem and over a wrong status", async () => {
    h.offer = { data: offerRow({ client_email: "", status: "signed", services: [{ name: "Formation", pipeline_type: "Company Formation" }] }), error: null }
    expect((await publish()).error).toBe("Cannot publish: client_email is not set on this offer. Update it first.")
  })

  it("order: the yearly fee problem wins over a wrong status", async () => {
    h.offer = { data: offerRow({ status: "viewed", services: [{ name: "Formation", pipeline_type: "Company Formation" }] }), error: null }
    expect((await publish()).error).toContain("This offer has no yearly fee.")
  })

  it("order: a wrong status wins over a service that is not ready", async () => {
    h.offer = { data: offerRow({ status: "signed", services: apostilleLines }), error: null }
    h.catalog = { data: [], error: null }
    expect((await publish()).error).toBe("Cannot publish: offer is in 'signed' status. Only 'draft' offers can be published.")
  })
})

describe("publishOffer — a NEW service that is not ready (the answer is the engine's list, with fix links)", () => {
  beforeEach(() => {
    h.offer = { data: offerRow({ services: apostilleLines }), error: null }
  })

  it("a ready new service passes", async () => {
    h.catalog = { data: [apostille()], error: null }
    h.stages = { data: [{ service_type: "Apostille" }], error: null }
    expect((await publish()).error).toBe(PASSED)
  })

  it("a new service that is not in the catalog", async () => {
    const r = await publish()
    expect(r.error).toContain('Cannot publish: "Apostille" is not in the Service Catalog')
    expect(r.blockers?.map((b) => b.kind)).toEqual(["not_in_catalog"])
    expect(h.portal).not.toHaveBeenCalled()
    expect(h.ensure).not.toHaveBeenCalled()
  })

  it("a switched-off new service", async () => {
    h.catalog = { data: [apostille({ status: "deprecated" })], error: null }
    h.stages = { data: [{ service_type: "Apostille" }], error: null }
    const r = await publish()
    expect(r.error).toContain('"Apostille" is switched off in the Service Catalog')
    expect(r.blockers?.map((b) => b.kind)).toEqual(["switched_off"])
    expect(r.blockers?.[0].href).toBe("/service-catalog/apostille/edit#contract")
  })

  it("a new service with no steps", async () => {
    h.catalog = { data: [apostille()], error: null }
    h.stages = { data: [], error: null }
    const r = await publish()
    expect(r.error).toContain('"Apostille" has no steps yet, so nothing could start after payment')
    expect(r.blockers?.map((b) => b.kind)).toEqual(["steps"])
  })

  it("a new service with no contract at all", async () => {
    h.catalog = { data: [apostille({ metadata: { pipeline: "Apostille" } })], error: null }
    h.stages = { data: [{ service_type: "Apostille" }], error: null }
    const r = await publish()
    expect(r.error).toContain('"Apostille" has no contract yet, so the client would sign nothing for it')
    expect(r.blockers?.map((b) => b.kind)).toEqual(["contract"])
  })

  it("a new service whose own contract is still a draft", async () => {
    h.catalog = { data: [apostille({ metadata: { pipeline: "Apostille", contract_type: "custom_apostille" } })], error: null }
    h.stages = { data: [{ service_type: "Apostille" }], error: null }
    h.texts = { data: [{ service_entry_id: "e1", status: "draft" }], error: null }
    h.offer = { data: offerRow({ services: apostilleLines, contract_type: "shipping" }), error: null }
    const r = await publish()
    expect(r.error).toContain("has a contract draft that still needs the owner's approval")
    expect(r.blockers?.map((b) => b.kind)).toEqual(["contract"])
  })

  it("an approved own contract on an offer set up with the formation contract: the client would not sign it", async () => {
    h.catalog = { data: [apostille({ metadata: { pipeline: "Apostille", contract_type: "custom_apostille" } })], error: null }
    h.stages = { data: [{ service_type: "Apostille" }], error: null }
    h.texts = { data: [{ service_entry_id: "e1", status: "approved" }], error: null }
    h.offer = { data: offerRow({ services: apostilleLines, contract_type: "formation" }), error: null }
    const r = await publish()
    expect(r.error).toContain("delete this draft offer and create it again")
    expect(r.blockers?.map((b) => b.kind)).toEqual(["offer_type"])
  })

  it("an approved own contract on an offer that carries it passes", async () => {
    h.catalog = { data: [apostille({ metadata: { pipeline: "Apostille", contract_type: "custom_apostille" } })], error: null }
    h.stages = { data: [{ service_type: "Apostille" }], error: null }
    h.texts = { data: [{ service_entry_id: "e1", status: "approved" }], error: null }
    h.offer = { data: offerRow({ services: apostilleLines, contract_type: "shipping" }), error: null }
    expect((await publish()).error).toBe(PASSED)
  })

  it("a new service that is only in the bundled-services list is checked too", async () => {
    h.offer = { data: offerRow({ services: [{ name: "Tax Return" }], bundled_pipelines: ["Apostille"] }), error: null }
    const r = await publish()
    expect(r.blockers?.map((b) => b.kind)).toEqual(["not_in_catalog"])
  })

  it("a new service inside a package option is checked too", async () => {
    h.offer = { data: offerRow({ services: [{ name: "Tax Return" }] }), error: null }
    h.packages = { data: { packages: [{ label: "A", services: apostilleLines }] }, error: null }
    const r = await publish()
    expect(r.blockers?.map((b) => b.kind)).toEqual(["not_in_catalog"])
  })

  it("two problems at once: every reason is listed, joined into the error", async () => {
    h.offer = { data: offerRow({ services: [...apostilleLines, { name: "Notarisation", pipeline_type: "Notarisation" }] }), error: null }
    const r = await publish()
    expect(r.blockers?.map((b) => b.kind)).toEqual(["not_in_catalog", "not_in_catalog"])
    expect(r.error).toContain('"Apostille" is not in the Service Catalog')
    expect(r.error).toContain('"Notarisation" is not in the Service Catalog')
  })

  it("a failed lookup of the new services refuses (closed) and says to try again", async () => {
    h.catalog = { data: null, error: { message: "db down" } }
    const r = await publish()
    expect(r.error).toBe("Cannot publish: could not check the services on this offer (db down) — try again.")
    expect(r.blockers?.map((b) => b.kind)).toEqual(["lookup"])
    expect(h.portal).not.toHaveBeenCalled()
  })

  it("a two-service bundle (a new service next to the main one) is NOT refused for coverage today — only warned about when it is created", async () => {
    h.catalog = { data: [apostille()], error: null }
    h.stages = { data: [{ service_type: "Apostille" }], error: null }
    h.offer = { data: offerRow({ services: [{ name: "Tax Return", price: "$500" }, ...apostilleLines] }), error: null }
    expect((await publish()).error).toBe(PASSED)
  })
})

describe("publishOffer — the approved wording is frozen onto the offer (this step WRITES today)", () => {
  it("wording missing for a new service", async () => {
    h.ensure.mockResolvedValue({ texts: {}, missing: ["Apostille"], changed: false })
    const r = await publish()
    expect(r.error).toBe("Cannot publish: no approved contract wording for Apostille — approve the service's contract in the Service Catalog first.")
    expect(h.portal).not.toHaveBeenCalled()
  })

  it("wording missing for two services lists both", async () => {
    h.ensure.mockResolvedValue({ texts: {}, missing: ["A", "B"], changed: false })
    expect((await publish()).error).toContain("no approved contract wording for A, B")
  })

  it("the freeze throws", async () => {
    h.ensure.mockRejectedValue(new Error("boom"))
    const r = await publish()
    expect(r.error).toBe("Cannot publish: could not save the contract wording on the offer (boom) — try again.")
    expect(h.portal).not.toHaveBeenCalled()
  })

  it("the freeze only runs after every earlier check passed", async () => {
    h.offer = { data: offerRow({ client_email: null }), error: null }
    await publish()
    h.offer = { data: offerRow({ status: "sent" }), error: null }
    await publish()
    expect(h.ensure).not.toHaveBeenCalled()
  })
})

describe("publishOffer — reads that fail OPEN today (DELIBERATE CHANGE in step 1.2: a failed read becomes a refusal)", () => {
  it("TODAY: if the list of yearly-fee services cannot be read, the yearly-fee check is silently skipped", async () => {
    h.annual = { data: null, error: { message: "db down" } }
    h.offer = { data: offerRow({ services: [{ name: "Formation", pipeline_type: "Company Formation" }], recurring_costs: null }), error: null }
    expect((await publish()).error).toBe(PASSED)
  })

  it("TODAY: if the packages cannot be read, they are treated as 'no packages' and the offer goes on", async () => {
    h.packages = { data: null, error: { message: "db down" } }
    expect((await publish()).error).toBe(PASSED)
  })
})
