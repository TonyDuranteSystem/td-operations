/**
 * Flexible-offer track, Step 0: an offer cannot leave draft while it carries a
 * NEW service that has no steps, is switched off, or is not in the Service
 * Catalog. Historical service types (in any spelling) are never checked, so no
 * existing flow can start refusing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

type Result = { data: unknown; error: { message: string } | null }
const db = vi.hoisted(() => ({
  catalog: { data: [], error: null } as Result,
  stages: { data: [], error: null } as Result,
  offer: { data: null, error: null } as Result,
  tablesRead: [] as string[],
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      db.tablesRead.push(table)
      const result = table === "catalog_entries" ? db.catalog : table === "offers" ? db.offer : db.stages
      const chain = {
        select: () => chain,
        eq: () => (table === "offers" ? chain : Promise.resolve(result)),
        in: () => Promise.resolve(result),
        maybeSingle: () => Promise.resolve(result),
      }
      return chain
    },
  },
}))

import {
  newServiceTypesOnOffer,
  offerReadinessProblemForToken,
  offerServicesReadinessProblem,
  serviceReadinessProblem,
} from "@/lib/offers/service-readiness"

// The Step 0 tests are about steps / switched-off / spelling, so this sample service carries a BUILT-IN contract type (its contract is
// in code and needs no approval). What happens when the contract is missing or still a draft is in offer-service-readiness-contracts.test.ts.
const activeApostille = { id: "e1", slug: "apostille", display_name: "Apostille", status: "active", metadata: { pipeline: "Apostille", contract_type: "shipping" } }

beforeEach(() => {
  db.catalog = { data: [], error: null }
  db.stages = { data: [], error: null }
  db.offer = { data: null, error: null }
  db.tablesRead.length = 0
})

describe("newServiceTypesOnOffer", () => {
  it("returns only the names the old list does not know, once each, exactly as written", () => {
    const services = [
      { name: "Formation", pipeline_type: "Company Formation" },
      { name: "Apostille A", pipeline_type: "Apostille" },
      { name: "Notarisation", pipeline_type: "Notarisation" },
      { name: "Plain add-on" },
      { name: "Blank", pipeline_type: "   " },
      null,
      "junk",
    ]
    expect(newServiceTypesOnOffer({ services })).toEqual(["Apostille", "Notarisation"])
  })

  it("does NOT trim: a stray space is a different name (activation creates the delivery under it as written)", () => {
    expect(newServiceTypesOnOffer({ services: [{ pipeline_type: "Apostille " }] })).toEqual(["Apostille "])
  })

  it("treats a different capitalisation of a new service as a separate name, so both get checked", () => {
    expect(newServiceTypesOnOffer({ services: [{ pipeline_type: "Apostille" }, { pipeline_type: "apostille" }] })).toEqual(["Apostille", "apostille"])
  })

  it("skips historical names in any spelling or case", () => {
    const names = ["Company Formation", "company formation", "Company formation", "EIN", "ein", " ITIN ", "Annual Renewal", "Certificate of Incumbency", "company closure"]
    expect(newServiceTypesOnOffer({ services: names.map((t) => ({ pipeline_type: t })) })).toEqual([])
  })

  it("also reads every package option's lines and the bundled-services list", () => {
    const types = newServiceTypesOnOffer({
      services: [{ pipeline_type: "Apostille" }],
      packages: [
        { label: "A", services: [{ pipeline_type: "Company Formation" }] },
        { label: "B", services: [{ pipeline_type: "Notarisation" }, { pipeline_type: "Apostille" }] },
      ],
      bundledPipelines: ["Company Formation", "Legalisation", "State RA Renewal", "Notarisation"],
    })
    expect(types).toEqual(["Apostille", "Notarisation", "Legalisation"])
  })

  it("answers nothing for missing or malformed sources", () => {
    expect(newServiceTypesOnOffer({})).toEqual([])
    expect(newServiceTypesOnOffer({ services: {}, packages: "x", bundledPipelines: 5 })).toEqual([])
    expect(newServiceTypesOnOffer({ packages: [null, { services: "no" }, 7] })).toEqual([])
    expect(newServiceTypesOnOffer({ bundledPipelines: [null, 3, "", "  "] })).toEqual([])
  })
})

describe("serviceReadinessProblem", () => {
  it("is fine when the service is in the catalog, switched on and has steps", () => {
    expect(serviceReadinessProblem({ types: ["Apostille"], catalog: { Apostille: { name: "Apostille", active: true } }, stageCounts: { Apostille: 4 } })).toBeNull()
  })

  it("says a service with no steps cannot start after payment", () => {
    const msg = serviceReadinessProblem({ types: ["Apostille"], catalog: { Apostille: { name: "Apostille", active: true } }, stageCounts: {} })
    expect(msg).toMatch(/"Apostille" has no steps yet/)
  })

  it("says a switched-off service must be switched on or removed", () => {
    const msg = serviceReadinessProblem({ types: ["Apostille"], catalog: { Apostille: { name: "Apostille", active: false } }, stageCounts: { Apostille: 4 } })
    expect(msg).toMatch(/switched off/)
  })

  it("says a service the catalog does not have must be added or removed, and hints at spelling", () => {
    expect(serviceReadinessProblem({ types: ["Ghost"], catalog: { Ghost: null }, stageCounts: {} })).toMatch(/"Ghost" is not in the Service Catalog \(check the spelling/)
    expect(serviceReadinessProblem({ types: ["Ghost"], catalog: {}, stageCounts: {} })).toMatch(/not in the Service Catalog/)
  })

  it("reports every problem at once, one per service", () => {
    const msg = serviceReadinessProblem({
      types: ["A", "B", "C"],
      catalog: { A: { name: "A", active: true }, B: { name: "B", active: false }, C: null },
      stageCounts: {},
    })
    expect(msg).toMatch(/"A" has no steps/)
    expect(msg).toMatch(/"B" is switched off/)
    expect(msg).toMatch(/"C" is not in the Service Catalog/)
  })

  it("is not fooled by a type named like an object property", () => {
    expect(serviceReadinessProblem({ types: ["constructor"], catalog: {}, stageCounts: {} })).toMatch(/not in the Service Catalog/)
  })
})

describe("offerServicesReadinessProblem (database)", () => {
  it("does not touch the database for an offer with only historical services", async () => {
    expect(await offerServicesReadinessProblem({ services: [{ pipeline_type: "Company Formation" }, { name: "add-on" }], bundledPipelines: ["EIN"] })).toBeNull()
    expect(db.tablesRead).toEqual([])
  })

  it("passes a new service that is switched on and has steps", async () => {
    db.catalog = { data: [activeApostille], error: null }
    db.stages = { data: [{ service_type: "Apostille" }, { service_type: "Apostille" }], error: null }
    expect(await offerServicesReadinessProblem({ services: [{ pipeline_type: "Apostille" }] })).toBeNull()
  })

  it("refuses a new service with no steps", async () => {
    db.catalog = { data: [activeApostille], error: null }
    expect(await offerServicesReadinessProblem({ services: [{ pipeline_type: "Apostille" }] })).toMatch(/no steps yet/)
  })

  it("refuses a new service that appears ONLY in the bundled list or in a later package option", async () => {
    db.catalog = { data: [activeApostille], error: null }
    expect(await offerServicesReadinessProblem({ bundledPipelines: ["Apostille"] })).toMatch(/no steps yet/)
    expect(await offerServicesReadinessProblem({ packages: [{ services: [] }, { services: [{ pipeline_type: "Apostille" }] }] })).toMatch(/no steps yet/)
  })

  it("refuses a name with a stray space or wrong capitals even though the clean name is fine", async () => {
    db.catalog = { data: [activeApostille], error: null }
    db.stages = { data: [{ service_type: "Apostille" }], error: null }
    expect(await offerServicesReadinessProblem({ services: [{ pipeline_type: "Apostille" }] })).toBeNull()
    expect(await offerServicesReadinessProblem({ services: [{ pipeline_type: "Apostille " }] })).toMatch(/not in the Service Catalog/)
    expect(await offerServicesReadinessProblem({ services: [{ pipeline_type: "apostille" }] })).toMatch(/not in the Service Catalog/)
  })

  it("refuses a switched-off (deprecated) new service", async () => {
    db.catalog = { data: [{ ...activeApostille, status: "deprecated" }], error: null }
    db.stages = { data: [{ service_type: "Apostille" }], error: null }
    expect(await offerServicesReadinessProblem({ services: [{ pipeline_type: "Apostille" }] })).toMatch(/switched off/)
  })

  it("agrees with createSD on what 'off' means: only a deprecated row", async () => {
    db.catalog = { data: [{ ...activeApostille, status: "exception_only" }], error: null }
    db.stages = { data: [{ service_type: "Apostille" }], error: null }
    expect(await offerServicesReadinessProblem({ services: [{ pipeline_type: "Apostille" }] })).toBeNull()
  })

  it("prefers the switched-on row when two catalog rows share a pipeline name", async () => {
    db.catalog = { data: [{ ...activeApostille, slug: "a_old", status: "deprecated" }, activeApostille], error: null }
    db.stages = { data: [{ service_type: "Apostille" }], error: null }
    expect(await offerServicesReadinessProblem({ services: [{ pipeline_type: "Apostille" }] })).toBeNull()
  })

  it("refuses (closed) when the catalog cannot be read", async () => {
    db.catalog = { data: null, error: { message: "boom" } }
    expect(await offerServicesReadinessProblem({ services: [{ pipeline_type: "Apostille" }] })).toMatch(/could not check the services.*boom/)
  })

  it("refuses (closed) when the steps cannot be read", async () => {
    db.catalog = { data: [activeApostille], error: null }
    db.stages = { data: null, error: { message: "nope" } }
    expect(await offerServicesReadinessProblem({ services: [{ pipeline_type: "Apostille" }] })).toMatch(/could not check the services.*nope/)
  })
})

describe("offerReadinessProblemForToken (Activate Lead)", () => {
  it("reads the stored offer and applies the same check to all three places", async () => {
    db.offer = { data: { services: [], bundled_pipelines: ["Apostille"], packages: null }, error: null }
    db.catalog = { data: [activeApostille], error: null }
    expect(await offerReadinessProblemForToken("tok")).toMatch(/no steps yet/)
    expect(db.tablesRead[0]).toBe("offers")
  })

  it("has nothing to refuse for a missing offer, and refuses (closed) if the offer cannot be read", async () => {
    db.offer = { data: null, error: null }
    expect(await offerReadinessProblemForToken("missing")).toBeNull()
    db.offer = { data: null, error: { message: "db down" } }
    expect(await offerReadinessProblemForToken("tok")).toMatch(/could not check the services.*db down/)
  })

  it("passes an offer with only historical services without reading the catalog", async () => {
    db.offer = { data: { services: [{ pipeline_type: "ITIN" }], bundled_pipelines: ["ITIN"], packages: null }, error: null }
    expect(await offerReadinessProblemForToken("tok")).toBeNull()
    expect(db.tablesRead).toEqual(["offers"])
  })
})

describe("wiring", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

  it("publishOffer checks the offer's services after the draft test and before any portal user or email", () => {
    const src = read("lib/offers/publish.ts")
    const statusGate = src.indexOf(`offer.status !== "draft"`)
    const gate = src.indexOf("offerServicesReadiness({")
    const firstSideEffect = src.indexOf("autoCreatePortalUser({")
    expect(statusGate).toBeGreaterThan(0)
    expect(gate).toBeGreaterThan(statusGate)
    expect(firstSideEffect).toBeGreaterThan(gate)
    expect(src).toMatch(/Cannot publish: \$\{readiness\.problem\}/)
    expect(src).toMatch(/blockers: readiness\.blockers/)
    expect(src).toContain("bundledPipelines: offer.bundled_pipelines")
  })

  it("Activate Lead runs the same check before it creates a login or changes any status", () => {
    const src = read("app/api/crm/admin-actions/activate-lead/route.ts")
    const gate = src.indexOf("offerReadinessForToken(offer.token)")
    expect(gate).toBeGreaterThan(0)
    expect(src.indexOf("createUser({")).toBeGreaterThan(gate)
    expect(src.indexOf(".update({ status: 'sent' })")).toBeGreaterThan(gate)
    expect(src).toMatch(/Cannot activate: \$\{readiness\.problem\}/)
    expect(src).toMatch(/blockers: readiness\.blockers/)
  })
})

describe("wiring — when the wording is frozen (bug-hunter findings, 2026-10-26)", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
  it("Activate Lead takes a FRESH copy only for a draft; an offer already out keeps the wording it carries", () => {
    const src = read("app/api/crm/admin-actions/activate-lead/route.ts")
    expect(src).toMatch(/ensureOfferContractTexts\(offer\.token, offer\.status === 'draft' \? \{ refresh: true \} : \{\}\)/)
  })
  it("publishOffer takes a fresh copy at the real send", () => {
    expect(read("lib/offers/publish.ts")).toMatch(/ensureOfferContractTexts\(token, \{ refresh: true \}\)/)
  })
  it("the formation and onboarding pages: a new service's add-on agreement uses the shared body (approved phrases) and blocks signing when its wording is missing", () => {
    for (const f of ["app/offer/[token]/contract/page.tsx", "app/offer/[token]/contract/service-agreement.tsx"]) {
      const src = read(f)
      expect(src, f).toMatch(/isCustomContractType\(svcCt\) \? \(\s*\/\/[^\n]*\n\s*<AgreementBody /)
      expect(src, f).toMatch(/addonServices\.some\([^\n]*isCustomContractType[^\n]*return <ContractNotReady \/>/)
    }
  })
})

describe("migration 20261022-1200 (default tags for a new service)", () => {
  const dir = join(process.cwd(), "scripts/migrations")
  const up = readFileSync(join(dir, "20261022-1200-new-service-default-tags.sql"), "utf8")
  const undo = readFileSync(join(dir, "20261022-1200-new-service-default-tags.UNDO.sql"), "utf8")

  it("gives a service with a pipeline exactly the four default tags", () => {
    expect(up).toContain(`'["service", "sd", "sellable", "start_at_activation"]'::jsonb`)
  })

  it("decides the update-time tags on the row itself, never rewrites existing tags, and does not backfill", () => {
    expect(up).toContain(`WHEN v_pipeline_newly_set AND COALESCE(tags, '[]'::jsonb) = '[]'::jsonb THEN v_default_tags ELSE tags END`)
    expect(up).not.toMatch(/UPDATE\s+(public\.)?catalog_entries\s+SET\s+tags/i)
  })

  it("has an UNDO that restores empty tags on insert and never touches tags on update", () => {
    expect(undo).toContain(`'[]'::jsonb, v_new_metadata`)
    expect(undo).not.toContain("start_at_activation")
    expect(undo).not.toMatch(/tags\s+=/)
  })
})
