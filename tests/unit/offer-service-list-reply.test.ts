/**
 * The service list of Create Offer (lib/offers/service-list-reply.ts): only a reply that really is a list counts.
 */
import { describe, expect, it } from "vitest"
import { parseServiceListReply } from "@/lib/offers/service-list-reply"

describe("parseServiceListReply", () => {
  it("a good reply is the list", () => {
    const rows = [{ slug: "tax_return", name: "Tax Return" }, { slug: "itin", name: "ITIN Application" }]
    expect(parseServiceListReply(true, { services: rows })).toEqual(rows)
  })

  it("a good but empty list is an empty list (the caller decides whether to trust it)", () => {
    expect(parseServiceListReply(true, { services: [] })).toEqual([])
  })

  it("an expired login (401 + readable JSON with no services) is NOT a list — it used to become an empty one", () => {
    expect(parseServiceListReply(false, { error: "Session expired — please log in again.", code: "SESSION_EXPIRED" })).toBeNull()
    // even if a proxy answered 200 with the same body
    expect(parseServiceListReply(true, { error: "Session expired — please log in again.", code: "SESSION_EXPIRED" })).toBeNull()
  })

  it("a failed read of the list (500 + { error }) is not a list", () => {
    expect(parseServiceListReply(false, { error: "permission denied for view service_catalog" })).toBeNull()
  })

  it("a failed reply is never a list, even when the body carries one", () => {
    expect(parseServiceListReply(false, { services: [{ slug: "x" }] })).toBeNull()
  })

  it("anything that is not an object with a services array is not a list", () => {
    for (const body of [null, undefined, "<html>Sign in</html>", 7, [], { services: null }, { services: "x" }, { services: {} }]) {
      expect(parseServiceListReply(true, body)).toBeNull()
    }
  })

  it("rows that are not objects are dropped, the rest kept", () => {
    expect(parseServiceListReply(true, { services: [{ slug: "a" }, null, "b", 3, [], { slug: "c" }] })).toEqual([{ slug: "a" }, { slug: "c" }])
  })
})
