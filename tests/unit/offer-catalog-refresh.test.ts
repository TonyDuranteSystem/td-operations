import { describe, it, expect } from "vitest"
import {
  parseServiceCatalogReply,
  decideNewService,
  selectedServicesDrift,
  type ServiceListEntry,
} from "@/lib/offers/catalog-refresh"

const svc = (id: string, over: Partial<ServiceListEntry> = {}): ServiceListEntry => ({
  id,
  name: id.toUpperCase(),
  pipeline: null,
  contract_type: null,
  has_annual: false,
  ...over,
})

describe("parseServiceCatalogReply — a bad reply must never blank the list", () => {
  it("returns the rows of a good reply", () => {
    const rows = parseServiceCatalogReply(true, { services: [{ slug: "a" }, { slug: "b" }] })
    expect(rows).toEqual([{ slug: "a" }, { slug: "b" }])
  })

  it("returns null for a non-OK reply (expired login, server error)", () => {
    expect(parseServiceCatalogReply(false, { services: [{ slug: "a" }] })).toBeNull()
    expect(parseServiceCatalogReply(false, { error: "Unauthorized" })).toBeNull()
  })

  it("returns null when the body is not the expected shape (HTML page read as null, wrong key, wrong type)", () => {
    expect(parseServiceCatalogReply(true, null)).toBeNull()
    expect(parseServiceCatalogReply(true, "<html>")).toBeNull()
    expect(parseServiceCatalogReply(true, {})).toBeNull()
    expect(parseServiceCatalogReply(true, { services: "x" })).toBeNull()
    expect(parseServiceCatalogReply(true, { services: {} })).toBeNull()
  })

  it("returns null for an empty list: an empty catalog is never right, keep what is on screen", () => {
    expect(parseServiceCatalogReply(true, { services: [] })).toBeNull()
  })

  it("drops junk entries and returns null when nothing usable is left", () => {
    expect(parseServiceCatalogReply(true, { services: [null, 5, "x", [1]] })).toBeNull()
    expect(parseServiceCatalogReply(true, { services: [null, { slug: "a" }] })).toEqual([{ slug: "a" }])
  })
})

describe("decideNewService — which service gets ticked after 'Add a new service'", () => {
  it("waits while nothing new has appeared (the other tab is still open)", () => {
    expect(decideNewService(["a", "b"], ["a", "b"])).toEqual({ kind: "waiting" })
  })

  it("ticks exactly one new service, whatever it is called", () => {
    expect(decideNewService(["a", "b"], ["a", "b", "apostille_x"])).toEqual({ kind: "tick", id: "apostille_x" })
  })

  it("does not guess when more than one new service appeared", () => {
    expect(decideNewService(["a"], ["a", "x", "y"])).toEqual({ kind: "several", ids: ["x", "y"] })
  })

  it("ignores a service that went away, and duplicates in the fresh list", () => {
    expect(decideNewService(["a", "b"], ["a", "n", "n"])).toEqual({ kind: "tick", id: "n" })
    expect(decideNewService(["a", "b"], ["a"])).toEqual({ kind: "waiting" })
  })

  it("an empty 'before' list makes every service new (the dialog had loaded nothing)", () => {
    expect(decideNewService([], ["a"])).toEqual({ kind: "tick", id: "a" })
  })
})

describe("selectedServicesDrift — stop before saving a draft built on an old list", () => {
  const held = [svc("a"), svc("b", { pipeline: "Tax Return", contract_type: "tax_return" })]

  it("reports nothing when the ticked services are unchanged", () => {
    expect(selectedServicesDrift(["a", "b"], held, [...held, svc("new")])).toEqual({ missing: [], changed: [] })
  })

  it("reports a ticked service that is no longer on the fresh list", () => {
    expect(selectedServicesDrift(["a", "b"], held, [svc("a")])).toEqual({ missing: ["b"], changed: [] })
  })

  it("reports a contract type that changed since the list was loaded (the contract was finished in the other tab)", () => {
    const fresh = [svc("a", { contract_type: "custom_a" }), held[1]]
    expect(selectedServicesDrift(["a"], held, fresh)).toEqual({ missing: [], changed: ["a"] })
  })

  it("reports a changed job name, name and yearly-fee flag", () => {
    expect(selectedServicesDrift(["a"], held, [svc("a", { pipeline: "P" })]).changed).toEqual(["a"])
    expect(selectedServicesDrift(["a"], held, [svc("a", { name: "Renamed" })]).changed).toEqual(["a"])
    expect(selectedServicesDrift(["a"], held, [svc("a", { has_annual: true })]).changed).toEqual(["a"])
  })

  it("treats a ticked service the screen never held as changed (its contract type was never worked out)", () => {
    expect(selectedServicesDrift(["ghost"], held, [svc("ghost")])).toEqual({ missing: [], changed: ["ghost"] })
  })

  it("does not report services that are not ticked, and counts a ticked id once", () => {
    expect(selectedServicesDrift([], held, [])).toEqual({ missing: [], changed: [] })
    expect(selectedServicesDrift(["b", "b"], held, [])).toEqual({ missing: ["b"], changed: [] })
  })
})
