import { describe, it, expect } from "vitest"
import {
  assembleOwnershipAttestation, formatLongDate, nationalityLabel,
  type AttestationAccount, type AttestationMember, type AttestationContact,
} from "@/lib/operations/ownership-attestation"
import { generateOwnershipAttestationPDF, buildOwnershipAttestation } from "@/lib/pdf/ownership-attestation-pdf"

const account: AttestationAccount = {
  id: "a1", company_name: "Test Co LLC", state_of_formation: "New Mexico",
  physical_address: "10225 Ulmerton Rd, Largo, FL 33771", communication_email: null,
}
const member = (o: Partial<AttestationMember>): AttestationMember => ({
  id: "m", member_type: "individual", full_name: "Ann One", company_name: null, ownership_pct: 100,
  is_primary: true, is_signer: true, email: "ann@example.com", contact_id: "c1", ...o,
})
const contact = (o: Partial<AttestationContact> = {}): AttestationContact => ({
  id: "c1", full_name: "Ann One", email: "ann@example.com", date_of_birth: "1994-05-14", citizenship: "Italy", ...o,
})
const run = (members: AttestationMember[], contacts: AttestationContact[] = [contact()]) =>
  assembleOwnershipAttestation({ account, members, contacts, effectiveDate: "2026-10-23" })

describe("formatLongDate / nationalityLabel", () => {
  it("formats without time-zone shift", () => {
    expect(formatLongDate("1994-05-14")).toBe("May 14, 1994")
    expect(formatLongDate("2026-01-01T00:00:00+00:00")).toBe("January 1, 2026")
  })
  it("rejects garbage", () => {
    expect(formatLongDate(null)).toBeNull()
    expect(formatLongDate("14/05/1994")).toBeNull()
    expect(formatLongDate("1994-13-01")).toBeNull()
  })
  it("maps a country to a nationality, else prints the country as given", () => {
    expect(nationalityLabel("Italy")).toBe("Italian")
    expect(nationalityLabel(" portugal ")).toBe("Portuguese")
    expect(nationalityLabel("Atlantis")).toBe("Atlantis")
  })
})

describe("assembleOwnershipAttestation", () => {
  it("single owner with no percentage written down owns 100%", () => {
    const r = run([member({ ownership_pct: null })])
    expect(r.error).toBeUndefined()
    expect(r.input?.owners).toEqual([{ fullName: "Ann One", dateOfBirth: "May 14, 1994", nationality: "Italian", ownershipPct: 100 }])
    expect(r.input?.signerPosition).toBe("Sole Member / Owner")
    expect(r.input?.registeredIn).toBe("New Mexico, United States")
    expect(r.input?.contactEmail).toBe("ann@example.com")
  })
  it("names the signer (flagged signer first) with a contact and email", () => {
    const r = run(
      [member({ ownership_pct: 50, is_signer: false }), member({ id: "m2", full_name: "Bob Two", ownership_pct: 50, is_primary: false, is_signer: true, contact_id: "c2", email: "m-bob@example.com" })],
      [contact(), contact({ id: "c2", full_name: "Bob Two", email: "bob@example.com" })],
    )
    expect(r.signer).toEqual({ contactId: "c2", name: "Bob Two", email: "bob@example.com" })
    expect(r.input?.signerName).toBe("Bob Two")
  })
  it("two owners: only those with 25% or more appear (Aumianna shape 99/1)", () => {
    const r = run(
      [member({ ownership_pct: 99 }), member({ id: "m2", full_name: "Bob Two", ownership_pct: 1, is_primary: false, is_signer: false, contact_id: "c2" })],
      [contact(), contact({ id: "c2", full_name: "Bob Two" })],
    )
    expect(r.input?.owners.map(o => o.fullName)).toEqual(["Ann One"])
    expect(r.input?.signerPosition).toBe("Member")
  })
  it("three equal-ish owners all appear", () => {
    const r = run(
      [member({ ownership_pct: 40 }), member({ id: "m2", full_name: "B", ownership_pct: 30, contact_id: "c2", is_signer: false }), member({ id: "m3", full_name: "C", ownership_pct: 30, contact_id: "c3", is_signer: false })],
      [contact(), contact({ id: "c2" }), contact({ id: "c3" })],
    )
    expect(r.input?.owners).toHaveLength(3)
  })
  it("refuses: no members", () => expect(run([]).error).toMatch(/no owners/))
  it("refuses: percentages that do not add to 100", () => {
    expect(run([member({ ownership_pct: 60 }), member({ id: "m2", ownership_pct: 30, contact_id: "c2" })], [contact(), contact({ id: "c2" })]).error).toMatch(/add up to 90%/)
  })
  it("refuses: missing percentage on a multi-owner company", () => {
    expect(run([member({ ownership_pct: null }), member({ id: "m2", ownership_pct: 50, contact_id: "c2" })], [contact(), contact({ id: "c2" })]).error).toMatch(/percentage of Ann One is missing/)
  })
  it("refuses: nobody reaches 25%", () => {
    const ms = [1, 2, 3, 4, 5].map(i => member({ id: `m${i}`, full_name: `P${i}`, ownership_pct: 20, contact_id: `c${i}` }))
    expect(run(ms, ms.map(m => contact({ id: m.contact_id as string }))).error).toMatch(/hand/)
  })
  it("refuses: interest held through a company", () => {
    const r = run([member({ ownership_pct: 50 }), member({ id: "m2", member_type: "company", full_name: null, company_name: "Holdco", ownership_pct: 50 })])
    expect(r.error).toMatch(/through a company/)
  })
  it("refuses: owner without birth date, citizenship or contact", () => {
    expect(run([member({})], [contact({ date_of_birth: null })]).error).toMatch(/date of birth/)
    expect(run([member({})], [contact({ citizenship: " " })]).error).toMatch(/citizenship/)
    expect(run([member({})], []).error).toMatch(/not linked to a contact/)
  })
  it("refuses: company with no address or state", () => {
    expect(assembleOwnershipAttestation({ account: { ...account, physical_address: null }, members: [member({})], contacts: [contact()], effectiveDate: "2026-10-23" }).error).toMatch(/address/)
    expect(assembleOwnershipAttestation({ account: { ...account, state_of_formation: null }, members: [member({})], contacts: [contact()], effectiveDate: "2026-10-23" }).error).toMatch(/state/)
  })
})

describe("generateOwnershipAttestationPDF", () => {
  const base = {
    companyName: "Test Co LLC", registeredIn: "New Mexico, United States", companyAddress: "10225 Ulmerton Rd, Largo, FL",
    contactEmail: "a@b.c", dateLine: "October 23, 2026", signerName: "Ann One", signerPosition: "Sole Member / Owner",
  }
  const owner = (n: string, p: number) => ({ fullName: n, dateOfBirth: "May 14, 1994", nationality: "Italian", ownershipPct: p })
  it("makes a one-page PDF for 1 and for 4 owners", async () => {
    for (const owners of [[owner("A", 100)], [owner("A", 25), owner("B", 25), owner("C", 25), owner("D", 25)]]) {
      const bytes = await generateOwnershipAttestationPDF({ ...base, owners })
      expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-")
    }
  })
  it("refuses 0 or 5 owners", async () => {
    await expect(generateOwnershipAttestationPDF({ ...base, owners: [] })).rejects.toThrow()
    await expect(generateOwnershipAttestationPDF({ ...base, owners: [1, 2, 3, 4, 5].map(i => owner(`P${i}`, 20)) })).rejects.toThrow()
  })
  it("prints non-Latin names without crashing", async () => {
    const bytes = await generateOwnershipAttestationPDF({ ...base, owners: [owner("Łukasz Ñandú Ħ", 100)] })
    expect(bytes.length).toBeGreaterThan(1000)
  })
  it("reports a signature box on page 1, inside the page, above the blank 'Signed by' line", async () => {
    for (const owners of [[owner("A", 100)], [owner("A", 40), owner("B", 30), owner("C", 30)]]) {
      const { signature } = await buildOwnershipAttestation({ ...base, owners })
      expect(signature.page_index).toBe(0)
      expect(signature.pos_x).toBeGreaterThan(0)
      expect(signature.pos_x + signature.width).toBeLessThanOrEqual(1)
      expect(signature.pos_y).toBeGreaterThan(0.5) // lower half of the page
      expect(signature.pos_y + signature.height).toBeLessThanOrEqual(1)
      expect(signature.width).toBeGreaterThan(0.2)
    }
  })
})
