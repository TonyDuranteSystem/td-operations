import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

/**
 * Formation contracts: bundled services that start AT PAYMENT (catalog tag
 * start_at_activation — Company Closure). Dev job 77b66080: a paid
 * "Formation + Closure" contract silently never got its closure (Milan).
 */

// ── mocks ──────────────────────────────────────────────────────────────────
const reported: string[] = []
vi.mock("@/lib/system-errors", () => ({
  reportSystemError: vi.fn(async (e: { message: string }) => { reported.push(e.message); return null }),
}))

const createSD = vi.fn()
vi.mock("@/lib/operations/service-delivery", () => ({ createSD: (...a: unknown[]) => createSD(...a) }))

// Query router: which table + filters decide the fixture.
let byOfferRows: Array<{ id: string; status: string }> = []
let byOfferAfterCreateRows: Array<{ id: string }> | null = null
let openRows: Array<{ id: string; status: string; account_id: string | null }> = []
let linkRows: Array<{ account_id: string }> = []
let openErr: { message: string } | null = null
let createAttempted = false
const orFilters: string[] = []

vi.mock("@/lib/supabase-admin", () => {
  const make = (table: string) => {
    const state: { hasOfferToken: boolean; hasStatusIn: boolean } = { hasOfferToken: false, hasStatusIn: false }
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.eq = (col: string) => { if (col === "source_offer_token") state.hasOfferToken = true; return c }
    c.in = (col: string) => { if (col === "status") state.hasStatusIn = true; return c }
    c.or = (f: string) => { orFilters.push(f); return c }
    c.limit = async () => {
      if (table === "account_contacts") return { data: linkRows, error: null }
      if (table === "service_deliveries" && state.hasOfferToken) {
        if (createAttempted && byOfferAfterCreateRows) return { data: byOfferAfterCreateRows, error: null }
        return { data: byOfferRows, error: null }
      }
      if (table === "service_deliveries" && state.hasStatusIn) return { data: openErr ? null : openRows, error: openErr }
      return { data: [], error: null }
    }
    // account_contacts is awaited without .limit()
    c.then = (res: (v: unknown) => void) => res(table === "account_contacts" ? { data: linkRows, error: null } : { data: [], error: null })
    return c
  }
  return { supabaseAdmin: { from: (t: string) => make(t) } }
})

const listEntries = vi.fn()
vi.mock("@/lib/catalog/framework", async (orig) => ({ ...(await orig<object>()), listEntries: (...a: unknown[]) => listEntries(...a) }))

import { selectStartAtActivationPipelines, createStartAtActivationSDs, contractBoughtService, decideStartServiceScope, createBoughtStartAtActivationServices, isFormationContractWithoutFormation } from "@/lib/operations/activation-start-services"
import { getStartAtActivationServiceTypes, _resetServicesCache } from "@/lib/services"

const TYPES = ["Company Closure"]
const closureLine = { name: "Company Closure", price: "$0", pipeline_type: "Company Closure" }

// ── catalog helper ────────────────────────────────────────────────────────
describe("getStartAtActivationServiceTypes", () => {
  beforeEach(() => { _resetServicesCache(); listEntries.mockReset() })
  it("returns service types whose catalog entry is tagged start_at_activation (active only)", async () => {
    listEntries.mockResolvedValue([
      { slug: "closure", status: "active", tags: ["service", "sd", "start_at_activation"] },
      { slug: "itin", status: "active", tags: ["service", "start_at_wizard"] },
    ])
    expect(await getStartAtActivationServiceTypes()).toEqual(["Company Closure"])
  })
  it("untagged → nothing (code shipped before the migration is a no-op)", async () => {
    listEntries.mockResolvedValue([{ slug: "closure", status: "active", tags: ["service", "sd"] }])
    expect(await getStartAtActivationServiceTypes()).toEqual([])
  })
})

// ── what did the client actually buy ─────────────────────────────────────
describe("selectStartAtActivationPipelines", () => {
  it("Milan shape: non-optional closure line → created, no mismatch", () => {
    const r = selectStartAtActivationPipelines({
      services: [{ name: "Company Formation", pipeline_type: "Company Formation" }, closureLine],
      selectedServices: null,
      bundledPipelines: ["Company Formation", "Company Closure"],
      startAtActivationTypes: TYPES,
    })
    expect(r.pipelines).toEqual(["Company Closure"])
    expect(r.mismatches).toEqual([])
  })
  it("optional closure the client UNTICKED → not created, even if still in the bundled list (reported)", () => {
    const r = selectStartAtActivationPipelines({
      services: [{ ...closureLine, optional: true }],
      selectedServices: ["Company Formation"],
      bundledPipelines: ["Company Closure"],
      startAtActivationTypes: TYPES,
    })
    expect(r.pipelines).toEqual([])
    expect(r.mismatches.length).toBe(1)
  })
  it("optional closure the client TICKED → created", () => {
    const r = selectStartAtActivationPipelines({
      services: [{ ...closureLine, optional: true }],
      selectedServices: ["Company Closure"],
      bundledPipelines: ["Company Closure"],
      startAtActivationTypes: TYPES,
    })
    expect(r.pipelines).toEqual(["Company Closure"])
  })
  it("pipeline_type matched case-insensitively", () => {
    const r = selectStartAtActivationPipelines({
      services: [{ name: "Account Closure", pipeline_type: " company closure " }],
      selectedServices: null,
      bundledPipelines: ["Company Closure"],
      startAtActivationTypes: TYPES,
    })
    expect(r.pipelines).toEqual(["Company Closure"])
  })
  it("bundled closure but the line has no pipeline_type → NOT created and REPORTED (never silent)", () => {
    const r = selectStartAtActivationPipelines({
      services: [{ name: "Company Closure LLC Delaware" }],
      selectedServices: null,
      bundledPipelines: ["Company Closure"],
      startAtActivationTypes: TYPES,
    })
    expect(r.pipelines).toEqual([])
    expect(r.mismatches[0]).toMatch(/no bought line maps to it/)
  })
  it("bought closure missing from the bundled list → still created, reported", () => {
    const r = selectStartAtActivationPipelines({
      services: [closureLine],
      selectedServices: null,
      bundledPipelines: ["Company Formation"],
      startAtActivationTypes: TYPES,
    })
    expect(r.pipelines).toEqual(["Company Closure"])
    expect(r.mismatches[0]).toMatch(/missing from the contract's service list/)
  })
  it("no closure anywhere → nothing, no noise", () => {
    const r = selectStartAtActivationPipelines({
      services: [{ name: "Company Formation", pipeline_type: "Company Formation" }],
      selectedServices: null,
      bundledPipelines: ["Company Formation", "ITIN"],
      startAtActivationTypes: TYPES,
    })
    expect(r).toEqual({ pipelines: [], mismatches: [], multiQuantity: [] })
  })
  it("two separate closure lines (two old LLCs) → flagged like quantity 2, never silently collapsed", () => {
    const r = selectStartAtActivationPipelines({
      services: [{ name: "Closure – Old LLC A", pipeline_type: "Company Closure" }, { name: "Closure – Old LLC B", pipeline_type: "Company Closure" }],
      selectedServices: null,
      bundledPipelines: ["Company Closure"],
      startAtActivationTypes: TYPES,
    })
    expect(r.pipelines).toEqual(["Company Closure"])
    expect(r.multiQuantity).toEqual(["Company Closure"])
  })
  it("a malformed (null) service line is ignored, never throws", () => {
    expect(() => selectStartAtActivationPipelines({ services: [null, closureLine], selectedServices: null, bundledPipelines: ["Company Closure"], startAtActivationTypes: TYPES })).not.toThrow()
  })
  it("quantity > 1 flagged", () => {
    const r = selectStartAtActivationPipelines({
      services: [{ ...closureLine, quantity: 2 }],
      selectedServices: null,
      bundledPipelines: ["Company Closure"],
      startAtActivationTypes: TYPES,
    })
    expect(r.multiQuantity).toEqual(["Company Closure"])
  })
})

// ── creating the SD ──────────────────────────────────────────────────────
describe("createStartAtActivationSDs", () => {
  const sel = { pipelines: ["Company Closure"], mismatches: [], multiQuantity: [] }
  beforeEach(() => {
    byOfferRows = []; byOfferAfterCreateRows = null; openRows = []; linkRows = []; openErr = null
    createAttempted = false; orFilters.length = 0; reported.length = 0
    createSD.mockReset()
    createSD.mockImplementation(async () => { createAttempted = true; return { id: "sd-new" } })
  })

  it("creates a contact-scoped closure SD named after the client, carrying the offer token", async () => {
    const steps = await createStartAtActivationSDs({ offerToken: "magyardi-milan-2026", clientName: "Magyaródi Milan", contactId: "c1", selection: sel })
    expect(createSD).toHaveBeenCalledWith(expect.objectContaining({
      service_type: "Company Closure",
      service_name: "Company Closure - Magyaródi Milan",
      contact_id: "c1",
      account_id: null,
      source_offer_token: "magyardi-milan-2026",
    }))
    expect(steps[0]).toMatchObject({ status: "created" })
    expect(reported).toEqual([])
  })

  it("already created from this offer (any status, incl. cancelled) → not re-created", async () => {
    byOfferRows = [{ id: "sd-old", status: "cancelled" }]
    const steps = await createStartAtActivationSDs({ offerToken: "t", clientName: "X", contactId: "c1", selection: sel })
    expect(createSD).not.toHaveBeenCalled()
    expect(steps[0].status).toBe("existing")
  })

  it("an open closure added BY HAND (no offer token) → not duplicated, and reported with client + offer", async () => {
    openRows = [{ id: "sd-manual", status: "active", account_id: null }]
    const steps = await createStartAtActivationSDs({ offerToken: "magyardi-milan-2026", clientName: "Magyaródi Milan", contactId: "c1", selection: sel })
    expect(createSD).not.toHaveBeenCalled()
    expect(steps[0].status).toBe("existing")
    expect(reported[0]).toContain("Magyaródi Milan")
    expect(reported[0]).toContain("magyardi-milan-2026")
  })

  it("with no linked companies, the open-closure check is the person only", async () => {
    await createStartAtActivationSDs({ offerToken: "t", clientName: "X", contactId: "c1", selection: sel })
    expect(orFilters[0]).toBe("and(contact_id.eq.c1,account_id.is.null)")
  })

  it("the open-closure check also covers the person's COMPANIES", async () => {
    linkRows = [{ account_id: "acct-1" }, { account_id: "acct-2" }]
    await createStartAtActivationSDs({ offerToken: "t", clientName: "X", contactId: "c1", selection: sel })
    expect(orFilters[0]).toBe("and(contact_id.eq.c1,account_id.is.null),account_id.in.(acct-1,acct-2)")
  })

  it("no contact on the offer → skipped and reported", async () => {
    const steps = await createStartAtActivationSDs({ offerToken: "t", clientName: "X", contactId: null, selection: sel })
    expect(createSD).not.toHaveBeenCalled()
    expect(steps[0].status).toBe("skipped")
    expect(reported.length).toBe(1)
  })

  it("concurrent run won the unique index → 'existing', not an error", async () => {
    createSD.mockImplementation(async () => { createAttempted = true; throw new Error("duplicate key value violates unique constraint") })
    byOfferAfterCreateRows = [{ id: "sd-winner" }]
    const steps = await createStartAtActivationSDs({ offerToken: "t", clientName: "X", contactId: "c1", selection: sel })
    expect(steps[0]).toMatchObject({ status: "existing" })
    expect(reported).toEqual([])
  })

  it("a real failure never throws: error step + report naming the client", async () => {
    createSD.mockImplementation(async () => { createAttempted = true; throw new Error("boom") })
    const steps = await createStartAtActivationSDs({ offerToken: "t-99", clientName: "Jane Doe", contactId: "c1", selection: sel })
    expect(steps[0].status).toBe("error")
    expect(reported[0]).toContain("Jane Doe")
    expect(reported[0]).toContain("t-99")
  })

  it("a lookup error is reported, nothing created", async () => {
    openErr = { message: "db down" }
    const steps = await createStartAtActivationSDs({ offerToken: "t", clientName: "X", contactId: "c1", selection: sel })
    expect(createSD).not.toHaveBeenCalled()
    expect(steps[0].status).toBe("error")
  })

  it("mismatches are reported as informational steps", async () => {
    await createStartAtActivationSDs({ offerToken: "t", clientName: "X", contactId: "c1", selection: { pipelines: [], mismatches: ["m1"], multiQuantity: [] } })
    expect(reported[0]).toMatch(/^\[info\]/)
  })

  it("quantity > 1: one created + a report to add the rest by hand", async () => {
    const steps = await createStartAtActivationSDs({ offerToken: "t", clientName: "X", contactId: "c1", selection: { ...sel, multiQuantity: ["Company Closure"] } })
    expect(createSD).toHaveBeenCalledTimes(1)
    expect(steps.map((s) => s.status)).toEqual(["created", "skipped"])
  })
})

// ── legacy closure-form route never adopts a payment-created closure ─────
describe("closure-form-completed legacy lookup", () => {
  it("the token-less branch excludes closures created from an offer", () => {
    const src = readFileSync(join(process.cwd(), "app/api/closure-form-completed/route.ts"), "utf8")
    const expected = ".or(`source_closure_token.eq." + "$" + "{token},and(source_closure_token.is.null,source_offer_token.is.null)`)"
    expect(src).toContain(expected)
  })
})

// ── S1 (workspace-only plan, dev job 9d34e750) ─────────────────────────────

describe("contractBoughtService — no fake formation", () => {
  const formationLine = { name: "Company Formation", pipeline_type: "Company Formation" }
  it("formation in the bundled list → bought", () => {
    expect(contractBoughtService({ services: [], selectedServices: null, bundledPipelines: ["Company Formation"], serviceType: "Company Formation" })).toBe(true)
  })
  it("formation line only (bundled list empty) → bought", () => {
    expect(contractBoughtService({ services: [formationLine], selectedServices: null, bundledPipelines: [], serviceType: "Company Formation" })).toBe(true)
  })
  it("DF Commerce shape: formation-type contract selling only a name change → NOT a formation", () => {
    expect(contractBoughtService({ services: [{ name: "Company Change Name", pipeline_type: "Company Change Name" }], selectedServices: null, bundledPipelines: ["Company Change Name"], serviceType: "Company Formation" })).toBe(false)
  })
  it("SupraEmerge shape: closure only → NOT a formation", () => {
    expect(contractBoughtService({ services: [closureLine], selectedServices: null, bundledPipelines: ["Company Closure"], serviceType: "Company Formation" })).toBe(false)
  })
  it("an UNTICKED optional formation line is not bought", () => {
    expect(contractBoughtService({ services: [{ ...formationLine, optional: true }], selectedServices: ["Other"], bundledPipelines: [], serviceType: "Company Formation" })).toBe(false)
  })
  it("empty / malformed contract → not bought, never throws", () => {
    expect(contractBoughtService({ services: null, selectedServices: null, bundledPipelines: null, serviceType: "Company Formation" })).toBe(false)
  })
})

describe("decideStartServiceScope", () => {
  it("contact_eligible type (Closure) → on the person", () => {
    expect(decideStartServiceScope({ serviceType: "Company Closure", contactScopedTypes: ["Company Closure", "ITIN"], accountId: "acc1" })).toEqual({ kind: "contact" })
  })
  it("company type (Change Name) with the contract's company → on that company", () => {
    expect(decideStartServiceScope({ serviceType: "Company Change Name", contactScopedTypes: ["Company Closure"], accountId: "acc1" })).toEqual({ kind: "account", accountId: "acc1" })
  })
  it("company type with NO company on the contract → skipped (never guessed)", () => {
    expect(decideStartServiceScope({ serviceType: "Company Change Name", contactScopedTypes: ["Company Closure"], accountId: null }).kind).toBe("skip")
  })
  it("scope lookup failed (null) → legacy person-level behaviour", () => {
    expect(decideStartServiceScope({ serviceType: "Company Change Name", contactScopedTypes: null, accountId: null })).toEqual({ kind: "contact" })
  })
})

describe("createStartAtActivationSDs — company-scoped service", () => {
  const sel = { pipelines: ["Company Change Name"], mismatches: [], multiQuantity: [] }
  beforeEach(() => {
    byOfferRows = []; byOfferAfterCreateRows = null; openRows = []; linkRows = []; openErr = null
    createAttempted = false; orFilters.length = 0; reported.length = 0
    createSD.mockReset()
    createSD.mockImplementation(async () => { createAttempted = true; return { id: "sd-cn" } })
  })
  it("DF Commerce: name change created ON the contract's company, carrying the offer token", async () => {
    const steps = await createStartAtActivationSDs({ offerToken: "df-commerce-llc-2026", clientName: "DF Commerce LLC", contactId: "c1", selection: sel, accountId: "acc-df", contactScopedTypes: ["Company Closure"] })
    expect(createSD).toHaveBeenCalledWith(expect.objectContaining({ service_type: "Company Change Name", account_id: "acc-df", contact_id: "c1", source_offer_token: "df-commerce-llc-2026" }))
    expect(steps[0]).toMatchObject({ status: "created" })
    expect(orFilters).toEqual(["account_id.eq.acc-df"])
  })
  it("company service with NO contact still created on the company", async () => {
    await createStartAtActivationSDs({ offerToken: "t", clientName: "X", contactId: null, selection: sel, accountId: "acc-df", contactScopedTypes: ["Company Closure"] })
    expect(createSD).toHaveBeenCalledWith(expect.objectContaining({ account_id: "acc-df", contact_id: null }))
  })
  it("no company on the contract → not created, reported for staff", async () => {
    const steps = await createStartAtActivationSDs({ offerToken: "t", clientName: "X", contactId: "c1", selection: sel, accountId: null, contactScopedTypes: ["Company Closure"] })
    expect(createSD).not.toHaveBeenCalled()
    expect(steps[0].status).toBe("skipped")
    expect(reported[0]).toMatch(/no company linked/)
  })
  it("an open name change already on that company → not duplicated", async () => {
    openRows = [{ id: "sd-old", status: "active", account_id: "acc-df" }]
    const steps = await createStartAtActivationSDs({ offerToken: "t", clientName: "X", contactId: "c1", selection: sel, accountId: "acc-df", contactScopedTypes: ["Company Closure"] })
    expect(createSD).not.toHaveBeenCalled()
    expect(steps[0].status).toBe("existing")
  })
})

describe("createBoughtStartAtActivationServices — catalog-driven, formation AND onboarding", () => {
  beforeEach(() => {
    _resetServicesCache(); listEntries.mockReset()
    byOfferRows = []; byOfferAfterCreateRows = null; openRows = []; linkRows = []; openErr = null
    createAttempted = false; orFilters.length = 0; reported.length = 0
    createSD.mockReset()
    createSD.mockImplementation(async () => { createAttempted = true; return { id: "sd-x" } })
    listEntries.mockResolvedValue([
      { slug: "closure", status: "active", tags: ["sd", "contact_eligible", "start_at_activation"] },
      { slug: "company_change_name", status: "active", tags: ["sd", "start_at_activation"] },
      { slug: "itin", status: "active", tags: ["contact_eligible", "start_at_wizard"] },
    ])
  })
  it("closure → on the person; change name → on the contract's company; ITIN untouched (starts at the form)", async () => {
    await createBoughtStartAtActivationServices({
      offer: {
        services: [closureLine, { name: "Company Change Name", pipeline_type: "Company Change Name" }, { name: "ITIN", pipeline_type: "ITIN" }],
        selected_services: null,
        bundled_pipelines: ["Company Closure", "Company Change Name", "ITIN"],
        account_id: "acc1",
      },
      offerToken: "t", clientName: "X", contactId: "c1",
    })
    const calls = createSD.mock.calls.map((c) => c[0] as { service_type: string; account_id: string | null })
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ service_type: "Company Closure", account_id: null }),
      expect.objectContaining({ service_type: "Company Change Name", account_id: "acc1" }),
    ]))
    expect(calls.some((c) => c.service_type === "ITIN")).toBe(false)
  })
  it("nothing tagged → nothing created, no noise", async () => {
    listEntries.mockResolvedValue([{ slug: "closure", status: "active", tags: ["sd"] }])
    const steps = await createBoughtStartAtActivationServices({ offer: { services: [closureLine], bundled_pipelines: ["Company Closure"] }, offerToken: "t", clientName: "X", contactId: "c1" })
    expect(steps).toEqual([])
    expect(createSD).not.toHaveBeenCalled()
  })
  it("catalog lookup fails → error step + report, never throws", async () => {
    listEntries.mockRejectedValue(new Error("db down"))
    const steps = await createBoughtStartAtActivationServices({ offer: null, offerToken: "t", clientName: "X", contactId: "c1" })
    expect(steps[0].status).toBe("error")
    expect(reported[0]).toMatch(/NOT checked/)
  })
})

describe("isFormationContractWithoutFormation — who gets the formation experience", () => {
  const base = { selectedServices: null }
  it("DF Commerce (formation type, only a name change) → true", () => {
    expect(isFormationContractWithoutFormation({ ...base, contractType: "formation", services: [{ name: "Company Change Name", pipeline_type: "Company Change Name" }], bundledPipelines: ["Company Change Name"] })).toBe(true)
  })
  it("real formation → false", () => {
    expect(isFormationContractWithoutFormation({ ...base, contractType: "formation", services: [{ name: "Company Formation", pipeline_type: "Company Formation" }], bundledPipelines: ["Company Formation"] })).toBe(false)
  })
  it("AMBIGUOUS (no services named at all — legacy / MCP offer) → false: still treated as a formation", () => {
    expect(isFormationContractWithoutFormation({ ...base, contractType: "formation", services: [], bundledPipelines: [] })).toBe(false)
    expect(isFormationContractWithoutFormation({ ...base, contractType: "formation", services: [{ name: "LLC Formation" }], bundledPipelines: null })).toBe(false)
  })
  it("other contract types → always false", () => {
    expect(isFormationContractWithoutFormation({ ...base, contractType: "tax_return", services: [{ name: "Tax", pipeline_type: "Tax Return" }], bundledPipelines: ["Tax Return"] })).toBe(false)
  })
})

describe("createBoughtStartAtActivationServices — scope lookup failure", () => {
  it("creates NOTHING (never guesses person vs company), reports it", async () => {
    _resetServicesCache(); listEntries.mockReset(); reported.length = 0; createSD.mockReset()
    let call = 0
    listEntries.mockImplementation(async () => {
      call++
      if (call === 1) return [{ slug: "closure", status: "active", tags: ["contact_eligible", "start_at_activation"] }]
      throw new Error("db down")
    })
    // first helper call loads + caches; force the second lookup to fail by resetting the cache in between
    const services = await import("@/lib/services")
    const spy = vi.spyOn(services, "getContactEligibleServiceTypes").mockRejectedValueOnce(new Error("db down"))
    const steps = await createBoughtStartAtActivationServices({ offer: { services: [closureLine], bundled_pipelines: ["Company Closure"] }, offerToken: "t", clientName: "X", contactId: "c1" })
    spy.mockRestore()
    expect(createSD).not.toHaveBeenCalled()
    expect(steps[0].status).toBe("error")
    expect(reported.some((m) => /NOT created/.test(m))).toBe(true)
  })
})

