import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import OwnershipAttestationTemplate from "@/components/portal/ownership-attestation-template"

const base = {
  companyName: "Test Co LLC",
  registeredIn: "New Mexico, United States",
  companyAddress: "10225 Ulmerton Rd, Largo, FL 33771",
  contactEmail: "a@b.c",
  dateLine: "October 23, 2026",
  signerName: "Ann One",
  signerPosition: "Sole Member / Owner",
}
const owner = (n: string, p: number) => ({ fullName: n, dateOfBirth: "May 14, 1994", nationality: "Italian", ownershipPct: p })
const html = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(OwnershipAttestationTemplate, { ...base, ...props } as never))

describe("OwnershipAttestationTemplate", () => {
  it("prints the owner, the company, the confirmation and the signer — and no bank name", () => {
    const out = html({ owners: [owner("Ann One", 100)] })
    expect(out).toContain("UBO #1: Ann One")
    expect(out).toContain("Date of birth: May 14, 1994")
    expect(out).toContain("Nationality: Italian")
    expect(out).toContain("100.00%")
    expect(out).toContain("(Registered in New Mexico, United States)")
    expect(out).toContain("I confirm that these natural persons hold or control an interest of 25% or more of Test Co LLC")
    expect(out).toContain("Sole Member / Owner")
    expect(out).not.toMatch(/airwallex|^To:/i)
  })
  it("draws every owner box for several owners", () => {
    const out = html({ owners: [owner("A", 40), owner("B", 30), owner("C", 30)] })
    expect(out).toContain("UBO #1: A")
    expect(out).toContain("UBO #2: B")
    expect(out).toContain("UBO #3: C")
    expect(out).toContain("40.00%")
  })
  it("shows the signature image only when signed", () => {
    expect(html({ owners: [owner("A", 100)] })).not.toContain("<img")
    expect(html({ owners: [owner("A", 100)], signatureImage: "data:image/png;base64,AAAA" })).toContain('src="data:image/png;base64,AAAA"')
  })
})
