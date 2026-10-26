/**
 * Flexible-offer slice 2 step B: a NEW service also needs a contract that an owner approved before its offer
 * can be sent. Built-in contract types (in code) count as having one; a stored (custom_*) contract needs an
 * approved version; a draft is not enough; no contract type at all means nothing for the client to sign.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

type Result = { data: unknown; error: { message: string } | null }
const db = vi.hoisted(() => ({
  catalog: { data: [], error: null } as Result,
  stages: { data: [], error: null } as Result,
  texts: { data: [], error: null } as Result,
  tablesRead: [] as string[],
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      db.tablesRead.push(table)
      let ins = 0
      const result = table === "catalog_entries" ? db.catalog : table === "service_contract_texts" ? db.texts : db.stages
      const chain = {
        select: () => chain,
        eq: () => Promise.resolve(result),
        in: () => (table === "service_contract_texts" && ++ins < 2 ? chain : Promise.resolve(result)),
      }
      return chain
    },
  },
}))

import { contractProblem, offerServicesReadinessProblem, serviceReadinessProblem, serviceReadinessBlockers, offerServicesReadiness } from "@/lib/offers/service-readiness"

const entry = (over: Record<string, unknown> = {}) => ({ id: "e1", slug: "apostille", display_name: "Apostille", status: "active", metadata: { pipeline: "Apostille", contract_type: "custom_apostille" }, ...over })
const LINE = { name: "Apostille", pipeline_type: "Apostille", contract_type: "custom_apostille", price: "$150" }

beforeEach(() => {
  db.catalog = { data: [entry()], error: null }
  db.stages = { data: [{ service_type: "Apostille" }], error: null }
  db.texts = { data: [], error: null }
  db.tablesRead = []
})

describe("contractProblem — plain-English reason a new service's contract is not ready", () => {
  it("a built-in contract type has its contract in code: fine", () => {
    for (const t of ["tax_return", "shipping", "consulting_call"]) expect(contractProblem("X", { contractType: t, state: "none" }), t).toBeNull()
  })
  it("a stored contract: approved is fine; a draft needs the owner; none means create it", () => {
    expect(contractProblem("Apostille", { contractType: "custom_apostille", state: "approved" })).toBeNull()
    expect(contractProblem("Apostille", { contractType: "custom_apostille", state: "draft" })).toMatch(/draft that still needs the owner's approval/)
    expect(contractProblem("Apostille", { contractType: "custom_apostille", state: "none" })).toMatch(/has no contract yet/)
  })
  it("no contract type at all means the client would sign nothing for it", () => {
    for (const t of [null, "", "   "]) expect(contractProblem("Apostille", { contractType: t, state: "none" })).toMatch(/would sign nothing/)
  })
  it("a type the system does not know (a typo) is called out and tells what to do", () => {
    const p = contractProblem("Apostille", { contractType: "apostile", state: "none" })
    expect(p).toMatch(/"apostile"/)
    expect(p).toMatch(/not a contract the system knows/)
  })
})

describe("serviceReadinessProblem with contracts", () => {
  const base = { types: ["Apostille"], catalog: { Apostille: { name: "Apostille", active: true } }, stageCounts: { Apostille: 3 } }
  it("ready only when steps AND an approved contract exist", () => {
    expect(serviceReadinessProblem({ ...base, contracts: { Apostille: { contractType: "custom_apostille", state: "approved" } } })).toBeNull()
    expect(serviceReadinessProblem({ ...base, contracts: { Apostille: { contractType: "custom_apostille", state: "draft" } } })).toMatch(/draft/)
  })
  it("reports the missing steps and the missing contract together", () => {
    const p = serviceReadinessProblem({ ...base, stageCounts: {}, contracts: { Apostille: { contractType: null, state: "none" } } })
    expect(p).toMatch(/no steps yet/)
    expect(p).toMatch(/no contract yet/)
  })
  it("without the contracts input nothing about contracts is judged (the pure function stays backwards compatible)", () => {
    expect(serviceReadinessProblem(base)).toBeNull()
  })
})

describe("offerServicesReadinessProblem (database) — contracts", () => {
  it("refuses a new service whose contract is still a draft", async () => {
    db.texts = { data: [{ service_entry_id: "e1", status: "draft" }], error: null }
    expect(await offerServicesReadinessProblem({ services: [LINE] })).toMatch(/draft that still needs the owner's approval/)
  })
  it("refuses a new service with no contract versions at all", async () => {
    expect(await offerServicesReadinessProblem({ services: [LINE] })).toMatch(/has no contract yet/)
  })
  it("passes a new service with an approved contract", async () => {
    db.texts = { data: [{ service_entry_id: "e1", status: "approved" }], error: null }
    expect(await offerServicesReadinessProblem({ services: [LINE] })).toBeNull()
  })
  it("an approved version wins over an open draft for the same service", async () => {
    db.texts = { data: [{ service_entry_id: "e1", status: "draft" }, { service_entry_id: "e1", status: "approved" }], error: null }
    expect(await offerServicesReadinessProblem({ services: [LINE] })).toBeNull()
  })
  it("refuses a new service with NO contract type in the catalog, without reading the contract store", async () => {
    db.catalog = { data: [entry({ metadata: { pipeline: "Apostille" } })], error: null }
    expect(await offerServicesReadinessProblem({ services: [LINE] })).toMatch(/would sign nothing/)
    expect(db.tablesRead).not.toContain("service_contract_texts")
  })
  it("a new service that uses a BUILT-IN contract type needs no stored contract and never reads the store", async () => {
    db.catalog = { data: [entry({ metadata: { pipeline: "Apostille", contract_type: "shipping" } })], error: null }
    expect(await offerServicesReadinessProblem({ services: [LINE] })).toBeNull()
    expect(db.tablesRead).not.toContain("service_contract_texts")
  })
  it("refuses (closed) when the contract store cannot be read", async () => {
    db.texts = { data: null, error: { message: "relation does not exist" } }
    expect(await offerServicesReadinessProblem({ services: [LINE] })).toMatch(/could not check the contracts/)
  })
  it("an offer with only historical services never reads the contract store", async () => {
    expect(await offerServicesReadinessProblem({ services: [{ name: "Tax Return", pipeline_type: "Tax Return" }] })).toBeNull()
    expect(db.tablesRead).not.toContain("service_contract_texts")
  })
})


describe("blockers — one reason per line, with where to fix it (the CRM refusal pop-up)", () => {
  const cat = { Apostille: { name: "Apostille", slug: "apostille", active: true } }
  it("a stored contract with no approved version is a 'contract' blocker that links to the service's Contract card", () => {
    const b = serviceReadinessBlockers({ types: ["Apostille"], catalog: cat, stageCounts: { Apostille: 3 }, contracts: { Apostille: { contractType: "custom_apostille", state: "draft" } } })
    expect(b).toHaveLength(1)
    expect(b[0]).toMatchObject({ kind: "contract", serviceName: "Apostille", href: "/service-catalog/apostille/edit#contract" })
    expect(b[0].message).toMatch(/draft that still needs the owner's approval/)
  })
  it("steps and contract problems on the same service are two blockers; switched off stops at one", () => {
    const two = serviceReadinessBlockers({ types: ["Apostille"], catalog: cat, stageCounts: {}, contracts: { Apostille: { contractType: "custom_apostille", state: "none" } } })
    expect(two.map((x) => x.kind)).toEqual(["steps", "contract"])
    const off = serviceReadinessBlockers({ types: ["Apostille"], catalog: { Apostille: { name: "Apostille", slug: "apostille", active: false } }, stageCounts: {} })
    expect(off.map((x) => x.kind)).toEqual(["switched_off"])
  })
  it("a name missing from the catalog has no link", () => {
    const b = serviceReadinessBlockers({ types: ["Nope"], catalog: { Nope: null }, stageCounts: {} })
    expect(b[0]).toMatchObject({ kind: "not_in_catalog" })
    expect(b[0].href).toBeUndefined()
  })
  it("the one-sentence answer is exactly the blockers joined (nothing the MCP tools said changed)", () => {
    const args = { types: ["Apostille"], catalog: cat, stageCounts: {}, contracts: { Apostille: { contractType: "custom_apostille", state: "none" as const } } }
    expect(serviceReadinessProblem(args)).toBe(serviceReadinessBlockers(args).map((x) => x.message).join(" "))
  })
  it("the database check returns the blockers too, and a ready offer returns none", async () => {
    db.texts = { data: [], error: null }
    const r = await offerServicesReadiness({ services: [{ pipeline_type: "Apostille" }] })
    expect(r.blockers.map((x) => x.kind)).toEqual(["contract"])
    expect(r.problem).toBe(r.blockers[0].message)
    expect(r.blockers[0].href).toBe("/service-catalog/apostille/edit#contract")
    db.texts = { data: [{ service_entry_id: "e1", status: "approved" }], error: null }
    expect(await offerServicesReadiness({ services: [{ pipeline_type: "Apostille" }] })).toEqual({ problem: null, blockers: [] })
  })
  it("a failed lookup is one 'lookup' blocker (refuse closed)", async () => {
    db.catalog = { data: null, error: { message: "boom" } }
    const r = await offerServicesReadiness({ services: [{ pipeline_type: "Apostille" }] })
    expect(r.blockers).toHaveLength(1)
    expect(r.blockers[0].kind).toBe("lookup")
  })
})


describe("an offer whose overall contract cannot carry a new service's own agreement", () => {
  const cat = { Apostille: { name: "Apostille", slug: "apostille", active: true } }
  const base = { types: ["Apostille"], catalog: cat, stageCounts: { Apostille: 3 }, contracts: { Apostille: { contractType: "custom_apostille", state: "approved" as const } } }
  it("an approved own contract is not enough when the offer is set up with the formation contract: refuse, saying how to fix it", () => {
    const b = serviceReadinessBlockers({ ...base, offerContractType: "formation" })
    expect(b).toHaveLength(1)
    expect(b[0].kind).toBe("offer_type")
    expect(b[0].message).toMatch(/set up with the "formation" contract/)
    expect(b[0].message).toMatch(/delete this draft offer and create it again/)
    expect(b[0].href).toBeUndefined() // the fix is to rebuild the offer, not to open the contract
  })
  it("a REAL formation (or onboarding) offer — it has a line of that kind — carries the new service's agreement as an add-on: fine", () => {
    expect(serviceReadinessBlockers({ ...base, offerContractType: "formation", offerLineTypes: ["formation", "custom_apostille"] })).toEqual([])
    expect(serviceReadinessBlockers({ ...base, offerContractType: "onboarding", offerLineTypes: ["onboarding"] })).toEqual([])
  })
  it("…but a formation offer with NO formation line is the fallback, and is refused", () => {
    expect(serviceReadinessBlockers({ ...base, offerContractType: "formation", offerLineTypes: ["custom_apostille"] })).toHaveLength(1)
    expect(serviceReadinessBlockers({ ...base, offerContractType: "onboarding", offerLineTypes: ["formation"] })).toHaveLength(1)
    expect(serviceReadinessBlockers({ ...base, offerContractType: "renewal", offerLineTypes: ["renewal"] })).toHaveLength(1)
  })
  it("an MCP-built formation offer (its main lines are left UNTYPED; the pipeline says what they are) is a real formation offer", async () => {
    db.texts = { data: [{ service_entry_id: "e1", status: "approved" }], error: null }
    const mcp = { services: [{ pipeline_type: "Company Formation" }, { pipeline_type: "Apostille", contract_type: "custom_apostille" }], contractType: "formation" }
    expect(await offerServicesReadiness(mcp)).toEqual({ problem: null, blockers: [] })
    const onboarding = { services: [{ pipeline_type: "Client Onboarding" }, { pipeline_type: "Apostille" }], contractType: "onboarding" }
    expect(await offerServicesReadiness(onboarding)).toEqual({ problem: null, blockers: [] })
  })
  it("a package option holding only the new service is refused even when ANOTHER option has the formation line", async () => {
    db.texts = { data: [{ service_entry_id: "e1", status: "approved" }], error: null }
    const pk = { services: [], packages: [{ services: [{ pipeline_type: "Company Formation", contract_type: "formation" }] }, { services: [{ pipeline_type: "Apostille" }] }], contractType: "formation" }
    const r = await offerServicesReadiness(pk)
    expect(r.blockers.map((b) => b.kind)).toEqual(["offer_type"])
  })
  it("the database check reads the line types from the services and from every package option", async () => {
    db.texts = { data: [{ service_entry_id: "e1", status: "approved" }], error: null }
    const withFormation = { services: [{ pipeline_type: "Company Formation", contract_type: "formation" }, { pipeline_type: "Apostille" }], contractType: "formation" }
    expect(await offerServicesReadiness(withFormation)).toEqual({ problem: null, blockers: [] })
    const inPackage = { services: [], packages: [{ services: [{ pipeline_type: "Company Formation", contract_type: "formation" }, { pipeline_type: "Apostille" }] }], contractType: "formation" }
    expect(await offerServicesReadiness(inPackage)).toEqual({ problem: null, blockers: [] })
  })
  it("a null or empty offer type is judged as the formation contract (the page does the same)", () => {
    // with a real formation line it carries the add-on, exactly like type "formation"
    expect(serviceReadinessBlockers({ ...base, offerContractType: null, offerLineTypes: ["formation"] })).toEqual([])
    expect(serviceReadinessBlockers({ ...base, offerContractType: "", offerLineTypes: [] })).toHaveLength(1)
  })
  it("each PACKAGE OPTION holding the new service must be covered on its own (one option with a formation line does not cover another)", () => {
    const groups = [
      { pipelines: [], types: [] },
      { pipelines: ["Company Formation"], types: ["formation"] },
      { pipelines: ["Apostille"], types: ["custom_apostille"] },
    ]
    expect(serviceReadinessBlockers({ ...base, offerContractType: "formation", offerLineTypes: ["formation", "custom_apostille"], offerGroups: groups })).toHaveLength(1)
    const ok = [{ pipelines: ["Company Formation", "Apostille"], types: ["formation", "custom_apostille"] }]
    expect(serviceReadinessBlockers({ ...base, offerContractType: "formation", offerGroups: ok })).toEqual([])
  })
  it("an empty offer type reads as the formation fallback", () => {
    expect(serviceReadinessBlockers({ ...base, offerContractType: "" })[0].message).toMatch(/"formation" contract/)
    expect(serviceReadinessBlockers({ ...base, offerContractType: null })[0].message).toMatch(/"formation" contract/)
  })
  it("fine when the offer is a short-contract offer (its own type, or another short agreement), and when the offer type is not given", () => {
    expect(serviceReadinessBlockers({ ...base, offerContractType: "custom_apostille" })).toEqual([])
    expect(serviceReadinessBlockers({ ...base, offerContractType: "tax_return" })).toEqual([])
    expect(serviceReadinessBlockers(base)).toEqual([])
  })
  it("a built-in service (its contract in code) is never judged here", () => {
    expect(serviceReadinessBlockers({ ...base, contracts: { Apostille: { contractType: "shipping", state: "none" } }, offerContractType: "formation" })).toEqual([])
  })
  it("a service whose contract is still a draft gets BOTH reasons at once", () => {
    const b = serviceReadinessBlockers({ ...base, contracts: { Apostille: { contractType: "custom_apostille", state: "draft" } }, offerContractType: "formation" })
    expect(b.map((x) => x.kind)).toEqual(["contract", "offer_type"])
  })
  it("the database check passes the offer's type through", async () => {
    db.texts = { data: [{ service_entry_id: "e1", status: "approved" }], error: null }
    const r = await offerServicesReadiness({ services: [{ pipeline_type: "Apostille" }], contractType: "formation" })
    expect(r.blockers).toHaveLength(1)
    expect(r.problem).toMatch(/set up with the "formation" contract/)
    expect(await offerServicesReadiness({ services: [{ pipeline_type: "Apostille" }], contractType: "custom_apostille" })).toEqual({ problem: null, blockers: [] })
  })
})
