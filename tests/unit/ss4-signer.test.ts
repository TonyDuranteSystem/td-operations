import { describe, it, expect } from "vitest"
import { decideSs4Signer, ss4SignerAlertMessage, type Ss4SignerMember } from "@/lib/operations/ss4-signer"

const michele: Ss4SignerMember = { member_type: "individual", full_name: "Michele Cotti", contact_id: "michele-id", is_signer: true, is_primary: true }
const gaia: Ss4SignerMember = { member_type: "individual", full_name: "Gaia Pellegrinelli", contact_id: "gaia-id", is_signer: false }
const companyA: Ss4SignerMember = { member_type: "company", company_name: "Alpha Holdings LLC", representative_name: "Rep One", representative_email: "rep@alpha.com", is_signer: false }
const companyB: Ss4SignerMember = { member_type: "company", company_name: "Beta Holdings LLC", is_signer: false }

describe("decideSs4Signer", () => {
  it("returns no_members when the list is empty / null / undefined", () => {
    expect(decideSs4Signer([], "MMLLC")).toEqual({ kind: "no_members" })
    expect(decideSs4Signer(null, "MMLLC")).toEqual({ kind: "no_members" })
    expect(decideSs4Signer(undefined, "SMLLC")).toEqual({ kind: "no_members" })
  })

  it("SMLLC: uses the first (owner) member, no alert even if not flagged", () => {
    const owner: Ss4SignerMember = { member_type: "individual", full_name: "Solo Owner", contact_id: "owner-id", is_signer: false }
    const d = decideSs4Signer([owner], "SMLLC")
    expect(d).toEqual({ kind: "use_member", member: owner })
  })

  it("MMLLC with a single member row: unambiguous, uses it without requiring a flag", () => {
    const d = decideSs4Signer([gaia], "MMLLC")
    expect(d).toEqual({ kind: "use_member", member: gaia })
  })

  it("MMLLC, exactly one flagged signer: chooses that signer (the Michele fix)", () => {
    const d = decideSs4Signer([michele, gaia, companyA, companyB], "MMLLC")
    expect(d).toEqual({ kind: "use_member", member: michele })
  })

  it("MMLLC, zero flagged signers: blocks (this is the bug that stamped Gaia)", () => {
    const d = decideSs4Signer([gaia, companyA, companyB], "MMLLC")
    expect(d).toEqual({ kind: "needs_signer", signerCount: 0, memberCount: 3 })
  })

  it("MMLLC, more than one flagged signer: blocks", () => {
    const two = [{ ...michele }, { ...gaia, is_signer: true }, companyA]
    const d = decideSs4Signer(two, "MMLLC")
    expect(d).toEqual({ kind: "needs_signer", signerCount: 2, memberCount: 3 })
  })

  it("Corporation: treated like the unambiguous branch (first member)", () => {
    const pres: Ss4SignerMember = { member_type: "individual", full_name: "President", contact_id: "pres-id" }
    expect(decideSs4Signer([pres, gaia], "Corporation")).toEqual({ kind: "use_member", member: pres })
  })
})

describe("ss4SignerAlertMessage", () => {
  it("zero signers: tells staff to flag exactly one, lists members by name", () => {
    const msg = ss4SignerAlertMessage([gaia, companyA, companyB], 0)
    expect(msg).toContain("Multi-Member LLC with 3 members")
    expect(msg).toContain("no signer")
    expect(msg).toContain("Gaia Pellegrinelli")
    expect(msg).toContain("Alpha Holdings LLC (rep: Rep One)")
    expect(msg).toContain("Beta Holdings LLC")
    expect(msg).toContain("flag exactly one")
  })

  it("multiple signers: tells staff to leave exactly one, marks the flagged ones", () => {
    const msg = ss4SignerAlertMessage([{ ...michele }, { ...gaia, is_signer: true }], 2)
    expect(msg).toContain("2 signers flagged")
    expect(msg).toContain("Michele Cotti ✓ signer")
    expect(msg).toContain("Gaia Pellegrinelli ✓ signer")
    expect(msg).toContain("leave exactly one")
  })
})
