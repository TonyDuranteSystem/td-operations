/**
 * Flexible-offer track, Step 0: a service the catalog defines by itself (a new
 * service created in the Service Catalog screen) is recognised by the same
 * readers as the historical, hard-coded service types — without any of the
 * historical types changing meaning.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CatalogEntry } from "@/lib/catalog/framework"

const listEntriesMock = vi.hoisted(() => vi.fn())

vi.mock("@/lib/catalog/framework", () => ({
  listEntries: listEntriesMock,
  getEntry: vi.fn(),
  labelFor: vi.fn(),
}))

import {
  _resetServicesCache,
  assertServiceTypeNotDeprecated,
  buildServiceTypeMap,
  getContactEligibleServiceTypes,
  getEntryByServiceType,
  getPerPersonServiceTypes,
  getRepeatableServiceTypes,
  getStartAtActivationServiceTypes,
  getStartAtWizardServiceTypes,
  isLegacyServiceType,
} from "@/lib/services"

function entry(p: Partial<CatalogEntry> & { slug: string }): CatalogEntry {
  return {
    id: `id-${p.slug}`,
    catalog_id: "services",
    slug: p.slug,
    display_name: p.display_name ?? p.slug,
    display_name_translations: {},
    description: null,
    description_translations: {},
    status: p.status ?? "active",
    tags: p.tags ?? [],
    capabilities: {},
    metadata: p.metadata ?? {},
    created_at: "2026-10-22T00:00:00Z",
    updated_at: "2026-10-22T00:00:00Z",
    created_by: null,
    updated_by: null,
  }
}

const apostille = entry({
  slug: "apostille",
  display_name: "Apostille",
  tags: ["service", "sd", "sellable", "start_at_activation"],
  metadata: { pipeline: "Apostille" },
})

// The catalog row that legacy "Annual Renewal" offers point at (pipeline "Annual Renewal", no tags) and its retired SD twin.
const annualRenewalView = entry({ slug: "annual_renewal", display_name: "Annual Renewal", metadata: { pipeline: "Annual Renewal" } })
const annualRenewalSd = entry({ slug: "annual_renewal_sd", display_name: "Annual Renewal (Legacy SD)", status: "deprecated", tags: ["billing_cycle_artifact", "deprecated"] })
const shipping = entry({ slug: "shipping", display_name: "Shipping", tags: ["repeatable", "start_at_activation", "contact_eligible"], metadata: { pipeline: "Shipping" } })
const itin = entry({ slug: "itin", display_name: "ITIN", tags: ["per_person", "start_at_wizard", "contact_eligible"], metadata: { pipeline: "ITIN" } })

beforeEach(() => {
  _resetServicesCache()
  listEntriesMock.mockReset()
})

describe("buildServiceTypeMap", () => {
  it("keeps every legacy type exactly as before", () => {
    const map = buildServiceTypeMap([])
    expect(map["Company Formation"]).toBe("company_formation")
    expect(map["Banking Fintech"]).toBe("banking")
    expect(map.Shipping).toBe("shipping")
    expect(Object.keys(map)).toHaveLength(20)
  })

  it("adds a service the catalog defines by its pipeline name", () => {
    expect(buildServiceTypeMap([apostille]).Apostille).toBe("apostille")
  })

  it("never lets the catalog change a legacy type (Annual Renewal stays on its retired entry)", () => {
    const map = buildServiceTypeMap([annualRenewalView, annualRenewalSd, apostille])
    expect(map["Annual Renewal"]).toBe("annual_renewal_sd")
  })

  it("ignores rows with no pipeline name, a blank one, or a non-text one", () => {
    const map = buildServiceTypeMap([
      entry({ slug: "no_pipeline" }),
      entry({ slug: "blank", metadata: { pipeline: "   " } }),
      entry({ slug: "number", metadata: { pipeline: 5 } }),
    ])
    expect(Object.keys(map)).toHaveLength(20)
  })

  it("trims the pipeline name", () => {
    expect(buildServiceTypeMap([entry({ slug: "padded", metadata: { pipeline: "  Padded Service " } })])["Padded Service"]).toBe("padded")
  })

  it("on a clash prefers an active row, then the lower slug", () => {
    const off = entry({ slug: "a_off", status: "deprecated", metadata: { pipeline: "Clash" } })
    const on = entry({ slug: "z_on", metadata: { pipeline: "Clash" } })
    expect(buildServiceTypeMap([off, on]).Clash).toBe("z_on")
    const on2 = entry({ slug: "b_on", metadata: { pipeline: "Clash" } })
    expect(buildServiceTypeMap([on, on2]).Clash).toBe("b_on")
  })

  it("does not let a pipeline called like an object property break the map", () => {
    const map = buildServiceTypeMap([entry({ slug: "weird", metadata: { pipeline: "constructor" } })])
    expect(map.constructor).toBe("weird")
    expect(isLegacyServiceType("constructor")).toBe(false)
    expect(isLegacyServiceType("toString")).toBe(false)
  })

  it("a mis-cased copy of a legacy name can never take it over (typo 'ein', 'Company formation')", () => {
    const map = buildServiceTypeMap([
      entry({ slug: "typo_ein", metadata: { pipeline: "ein" } }),
      entry({ slug: "typo_formation", metadata: { pipeline: " Company formation " } }),
    ])
    expect(map.ein).toBeUndefined()
    expect(map["Company formation"]).toBeUndefined()
    expect(map.EIN).toBe("ein")
    expect(map["Company Formation"]).toBe("company_formation")
    expect(Object.keys(map)).toHaveLength(20)
  })
})

describe("isLegacyServiceType", () => {
  it("is true for the historical list and false for anything else", () => {
    expect(isLegacyServiceType("EIN")).toBe(true)
    expect(isLegacyServiceType("Certificate of Incumbency")).toBe(true)
    expect(isLegacyServiceType("Apostille")).toBe(false)
    expect(isLegacyServiceType("")).toBe(false)
  })

  it("ignores case and surrounding spaces, the way activation matches service names", () => {
    expect(isLegacyServiceType("ein")).toBe(true)
    expect(isLegacyServiceType("company formation")).toBe(true)
    expect(isLegacyServiceType("  Company Closure ")).toBe(true)
    expect(isLegacyServiceType("Company Formations")).toBe(false)
  })
})

describe("tag readers see a new service", () => {
  it("start-at-payment includes an active, tagged new service and keeps the legacy ones", async () => {
    listEntriesMock.mockResolvedValue([apostille, shipping, annualRenewalView, annualRenewalSd])
    const types = await getStartAtActivationServiceTypes()
    expect(types).toContain("Apostille")
    expect(types).toContain("Shipping")
    expect(types).not.toContain("Annual Renewal")
  })

  it("a switched-off new service is not listed", async () => {
    listEntriesMock.mockResolvedValue([{ ...apostille, status: "deprecated" }])
    expect(await getStartAtActivationServiceTypes()).not.toContain("Apostille")
  })

  it("a new service without the tag is not listed", async () => {
    listEntriesMock.mockResolvedValue([{ ...apostille, tags: ["service", "sd", "sellable"] }])
    expect(await getStartAtActivationServiceTypes()).not.toContain("Apostille")
  })

  it("each reader answers from its own tag", async () => {
    const tagged = entry({ slug: "everything", metadata: { pipeline: "Everything" }, tags: ["start_at_wizard", "repeatable", "contact_eligible", "per_person"] })
    listEntriesMock.mockResolvedValue([tagged, shipping, itin])
    expect(await getStartAtWizardServiceTypes()).toEqual(expect.arrayContaining(["Everything", "ITIN"]))
    expect(await getRepeatableServiceTypes()).toEqual(expect.arrayContaining(["Everything", "Shipping"]))
    expect(await getContactEligibleServiceTypes()).toEqual(expect.arrayContaining(["Everything", "Shipping", "ITIN"]))
    expect(await getPerPersonServiceTypes()).toEqual(expect.arrayContaining(["Everything", "ITIN"]))
    expect(await getPerPersonServiceTypes()).not.toContain("Shipping")
  })

  it("lists legacy types in their historical order before the catalog-defined ones", async () => {
    listEntriesMock.mockResolvedValue([apostille, shipping])
    const types = await getStartAtActivationServiceTypes()
    expect(types.indexOf("Shipping")).toBeLessThan(types.indexOf("Apostille"))
  })
})

describe("getEntryByServiceType / deprecation guard", () => {
  it("links a new service to its catalog row", async () => {
    listEntriesMock.mockResolvedValue([apostille])
    expect((await getEntryByServiceType("Apostille"))?.id).toBe("id-apostille")
  })

  it("still resolves legacy types, and returns null for a type nobody defines", async () => {
    listEntriesMock.mockResolvedValue([shipping])
    expect((await getEntryByServiceType("Shipping"))?.slug).toBe("shipping")
    expect(await getEntryByServiceType("Support")).toBeNull()
    expect(await getEntryByServiceType("toString")).toBeNull()
  })

  it("refuses to create a delivery for a switched-off new service", async () => {
    listEntriesMock.mockResolvedValue([{ ...apostille, status: "deprecated" }])
    await expect(assertServiceTypeNotDeprecated("Apostille", "test")).rejects.toThrow(/deprecated/)
  })

  it("lets an active new service through and returns its row", async () => {
    listEntriesMock.mockResolvedValue([apostille])
    expect((await assertServiceTypeNotDeprecated("Apostille", "test"))?.slug).toBe("apostille")
  })

  it("keeps refusing the retired Annual Renewal type", async () => {
    listEntriesMock.mockResolvedValue([annualRenewalView, annualRenewalSd])
    await expect(assertServiceTypeNotDeprecated("Annual Renewal", "test")).rejects.toThrow(/deprecated/)
  })
})
