import { describe, it, expect } from "vitest"
import { BOFA_SHIPPING_FIELDS, BOFA_SHIPPING_KEYS, shippingAddressFields, shippingAddressLines, withShippingAddress } from "@/lib/bofa-intake/shipping"
import { shippingForClient } from "@/lib/addresses"
import { TD_OFFICE } from "@/lib/td-address"
import { BOFA_TEXT_FIELDS, validateSubmission } from "@/lib/bofa-intake/schema"
import { buildDeliveryHtml } from "@/lib/bofa-intake/email"
import { buildSummaryPdf } from "@/lib/bofa-intake/summary-pdf"

describe("the locked shipping address", () => {
  it("is our Seminole office, the same address the portal's Shipping card shows", () => {
    const a = shippingAddressFields()
    expect(a.shipping_city).toBe("Seminole")
    expect(a.shipping_region).toBe("FL")
    expect(a.shipping_zip).toBe("33772")
    expect(a.shipping_name).toBe(TD_OFFICE.company)
    // one source of truth: it must never drift from the portal's Shipping Address card
    const portal = shippingForClient()
    expect(a.shipping_street).toBe(`${portal.address_line1}, ${portal.address_line2}`)
    expect(a.shipping_city).toBe(portal.city)
    expect(a.shipping_region).toBe(portal.state)
    expect(a.shipping_zip).toBe(portal.zip)
  })

  it("has a saved-answer key and a label for every part, and none collides with a question the client answers", () => {
    expect(BOFA_SHIPPING_KEYS).toEqual(BOFA_SHIPPING_FIELDS.map((f) => f.key))
    const asked = new Set(BOFA_TEXT_FIELDS.map((f) => f.key))
    for (const k of BOFA_SHIPPING_KEYS) expect(asked.has(k)).toBe(false)
    expect(Object.keys(shippingAddressFields()).sort()).toEqual([...BOFA_SHIPPING_KEYS].sort())
  })

  it("is stamped over anything the browser sent under those keys", () => {
    const stamped = withShippingAddress({ full_name: "A", shipping_city: "Mars", shipping_street: "1 Fake St", extra: "x" })
    expect(stamped.shipping_city).toBe("Seminole")
    expect(stamped.shipping_street).toBe(TD_OFFICE.street)
    expect(stamped.full_name).toBe("A")
  })

  it("validateSubmission never carries a client-sent shipping value into the saved answers", () => {
    const data: Record<string, string> = {}
    for (const f of BOFA_TEXT_FIELDS) data[f.key] = f.key === "email" ? "a@b.co" : f.key === "monthly_deposits" ? "Under $5,000" : "x"
    data.shipping_city = "Mars"
    const files = ["passport", "proof_of_address", "business_registration", "ein_letter", "itin_letter", "lease"].map((k) => ({ key: k, name: `${k}.pdf`, path: `tok/${k}/u-${k}.pdf` }))
    const r = validateSubmission(data, files, "tok")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).not.toHaveProperty("shipping_city")
  })

  it("prints as four plain lines", () => {
    expect(shippingAddressLines()).toEqual([TD_OFFICE.company, TD_OFFICE.street, "Seminole, FL 33772", TD_OFFICE.country])
  })
})

describe("where the shipping address shows up", () => {
  const base = { full_name: "Jordan Smith", company_name: "Northwind LLC" }

  it("is a section in the email to the bank contact when the application has it", () => {
    const html = buildDeliveryHtml(withShippingAddress(base), [])
    expect(html).toContain("Shipping address")
    expect(html).toContain("Seminole")
    expect(html).toContain("11125 Park Blvd")
  })

  it("is left out (not printed empty) for an application saved before it existed", () => {
    expect(buildDeliveryHtml(base, [])).not.toContain("Shipping address")
  })

  it("is in the answers PDF, and an old application still renders", async () => {
    const withIt = await buildSummaryPdf({ data: withShippingAddress(base), partner: null, submittedAt: null, requestId: "r1" })
    const without = await buildSummaryPdf({ data: base, partner: null, submittedAt: null, requestId: "r2" })
    expect(withIt.length).toBeGreaterThan(without.length)
    expect(without.subarray(0, 4).toString()).toBe("%PDF")
  })
})
