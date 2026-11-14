import { describe, it, expect } from "vitest"
import { leadsListHref, linksTabHref, parseBookingTab, BOOKING_PATH } from "@/lib/leads/leads-url"
import { parseLeadFilters } from "@/lib/leads/list-filters"

/** Parse an address the way the page receives it: the plain object Next.js hands a server page. */
function paramsOf(href: string): Record<string, string | string[] | undefined> {
  const q = href.split("?")[1] ?? ""
  const out: Record<string, string | string[] | undefined> = {}
  new URLSearchParams(q).forEach((v, k) => {
    const cur = out[k]
    out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v]
  })
  return out
}

describe("leadsListHref — the old /leads address and every list button land on the Leads tab with the same parameters", () => {
  it("no parameters: the Leads tab with nothing else", () => {
    expect(leadsListHref()).toBe("/booking?tab=leads")
    expect(leadsListHref("")).toBe("/booking?tab=leads")
    expect(leadsListHref(new URLSearchParams())).toBe("/booking?tab=leads")
    expect(leadsListHref({})).toBe("/booking?tab=leads")
  })

  it("keeps EVERY parameter the Leads list uses, with its value, in the same order", () => {
    const old = "q=smith&page=3&view=kanban&client=clients&status=New&src=Calendly&ref=Maria&offer=sent&call=upcoming&follow=due&quick=hot&focus=abc&id=def"
    const href = leadsListHref(old)
    expect(href).toBe(`/booking?tab=leads&${old}`)
    const before = paramsOf(`/leads?${old}`)
    const after = paramsOf(href)
    expect(after.tab).toBe("leads")
    for (const k of Object.keys(before)) expect(after[k], k).toEqual(before[k])
  })

  it("the same parameters in the form a server page receives them (an object, with a repeated key as a list)", () => {
    const href = leadsListHref({ q: "a b", status: ["New", "Lost"], client: undefined, view: "kanban" })
    expect(href).toBe("/booking?tab=leads&q=a+b&status=New&status=Lost&view=kanban")
  })

  it("a URLSearchParams from a button in the list (the Booking tab parameter already in it) comes out with exactly one tab", () => {
    const current = new URLSearchParams("tab=leads&q=x&page=2")
    current.delete("page")
    current.set("view", "kanban")
    const href = leadsListHref(current)
    expect(href).toBe("/booking?tab=leads&q=x&view=kanban")
    expect(href.match(/tab=/g)).toHaveLength(1)
  })

  it("an old link that carries its own `tab` cannot choose the Booking tab: it lands on Leads, and no other parameter is lost", () => {
    expect(leadsListHref("tab=links&q=x")).toBe("/booking?tab=leads&q=x")
    expect(leadsListHref({ tab: ["links", "links"], q: "x" })).toBe("/booking?tab=leads&q=x")
    expect(parseBookingTab(paramsOf(leadsListHref("tab=links&q=x")).tab)).toBe("leads")
  })

  it("values with odd characters survive the trip byte for byte (spaces, plus, ampersand, hash, accents, an address-looking value)", () => {
    const sp = new URLSearchParams()
    sp.set("q", "a&b=c d+e#f é")
    sp.set("ref", "//evil.example.net/x")
    const href = leadsListHref(sp)
    expect(href.startsWith("/booking?tab=leads&")).toBe(true)
    const back = new URLSearchParams(href.split("?")[1])
    expect(back.get("q")).toBe("a&b=c d+e#f é")
    expect(back.get("ref")).toBe("//evil.example.net/x")
    // always a path on this site: nothing in a value can turn it into an address elsewhere
    expect(href.startsWith("/booking?")).toBe(true)
    expect(href.split("?")[0]).toBe(BOOKING_PATH)
  })

  it("a leading question mark is tolerated", () => {
    expect(leadsListHref("?q=x")).toBe("/booking?tab=leads&q=x")
  })

  it("the list's own filters read the same from the new address as from the old one (the Existing Clients tab = `client`, the filter bar, the quick buttons)", () => {
    const old = "status=Qualified&src=Calendly&ref=Maria&offer=sent&call=upcoming&follow=due&quick=hot&client=converted&q=x"
    const a = parseLeadFilters(paramsOf(`/leads?${old}`))
    const b = parseLeadFilters(paramsOf(leadsListHref(old)))
    expect(b).toEqual(a)
    // the page's own reads of the other parameters
    const sa = paramsOf(`/leads?${old}`)
    const sb = paramsOf(leadsListHref(old))
    for (const k of ["q", "page", "view", "client"]) expect(sb[k], k).toEqual(sa[k])
  })
})

describe("parseBookingTab — which tab opens", () => {
  it("opens Leads by default and for anything it does not know (Leads is the daily work)", () => {
    for (const v of [undefined, null, "", "leads", "LEADS", "x", "link", "../x", ["bogus"], []]) expect(parseBookingTab(v as never), String(v)).toBe("leads")
  })
  it("opens Links and calls only when asked, in any capitals, first value only", () => {
    expect(parseBookingTab("links")).toBe("links")
    expect(parseBookingTab(" Links ")).toBe("links")
    expect(parseBookingTab(["links", "leads"])).toBe("links")
    expect(parseBookingTab(["leads", "links"])).toBe("leads")
  })
})

describe("linksTabHref", () => {
  it("is the Links and calls tab, optionally at the Calls to check section", () => {
    expect(linksTabHref()).toBe("/booking?tab=links")
    expect(linksTabHref("calls")).toBe("/booking?tab=links#calls")
  })
})
