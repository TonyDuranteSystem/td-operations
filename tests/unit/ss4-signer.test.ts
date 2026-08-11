import { describe, it, expect } from "vitest"
import {
  decideSs4Signer,
  ss4SignerAlertMessage,
  pickDefaultSs4SignerLink,
  isOwnerTypeRole,
  type Ss4SignerMember,
  type Ss4SignerLink,
} from "@/lib/operations/ss4-signer"

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

/**
 * The SMLLC default-pick rule (account_contacts). These are the cells that go red
 * if the fix is removed — see the "MUTATION PROOF" block at the end.
 *
 * Role strings below are the REAL production vocabulary (counted 2026-08-10):
 * owner 264 · Member 68 · Owner 27 · member 3 · authorized_representative 2 ·
 * "Sole Member" 1 · "Partner - Tax/NHR Consultant (Portugal)" 1 ·
 * "Collaborator - Client Communications (Francesco Valentini's team)" 1.
 */
describe("pickDefaultSs4SignerLink", () => {
  // Contact ids are ordered so that the WRONG answer is the lexicographically
  // first one — a fallback that ignored role would return `aaa…` and fail.
  const rep: Ss4SignerLink = { contact_id: "aaa-rep", role: "authorized_representative" }
  const owner: Ss4SignerLink = { contact_id: "zzz-owner", role: "owner" }

  it("returns null only for an empty / null / undefined list", () => {
    expect(pickDefaultSs4SignerLink([])).toBeNull()
    expect(pickDefaultSs4SignerLink(null)).toBeNull()
    expect(pickDefaultSs4SignerLink(undefined)).toBeNull()
  })

  it("THE ACE CASE: owner + authorized_representative → the OWNER, not the rep", () => {
    // Reproduces ACE Marketing Group LLC exactly: two links, the rep's contact
    // sorts first, and the old code took whichever row Postgres handed back.
    expect(pickDefaultSs4SignerLink([rep, owner])).toEqual(owner)
    // Order of the input must not change the answer.
    expect(pickDefaultSs4SignerLink([owner, rep])).toEqual(owner)
  })

  it("resolves every production role-case variant of owner", () => {
    for (const role of ["owner", "Owner", "OWNER", "  Owner  ", "Sole Member", "sole member"]) {
      const o: Ss4SignerLink = { contact_id: "zzz-owner", role }
      expect(pickDefaultSs4SignerLink([rep, o])).toEqual(o)
    }
  })

  it("NEVER blocks: two owner-type links still yield a default (Smart Consulting / Magic Scale shape)", () => {
    const a: Ss4SignerLink = { contact_id: "bbb", role: "owner" }
    const b: Ss4SignerLink = { contact_id: "ccc", role: "Owner" }
    const picked = pickDefaultSs4SignerLink([b, a])
    expect(picked).not.toBeNull()
    // Stable: lowest contact_id among the tied owner-type links, either input order.
    expect(picked).toEqual(a)
    expect(pickDefaultSs4SignerLink([a, b])).toEqual(a)
  })

  it("NEVER blocks: zero owner-type links still yield a default (partner/collaborator shape)", () => {
    const partner: Ss4SignerLink = { contact_id: "yyy", role: "Partner - Tax/NHR Consultant (Portugal)" }
    const collab: Ss4SignerLink = { contact_id: "xxx", role: "Collaborator - Client Communications (team)" }
    expect(pickDefaultSs4SignerLink([partner, collab])).toEqual(collab)
  })

  it("single link is used whatever its role — including a lone non-owner", () => {
    expect(pickDefaultSs4SignerLink([rep])).toEqual(rep)
    const lone: Ss4SignerLink = { contact_id: "solo", role: "Member" }
    expect(pickDefaultSs4SignerLink([lone])).toEqual(lone)
  })

  it("is null-safe on role (the column is nullable and the old cast lied about it)", () => {
    const nullRole: Ss4SignerLink = { contact_id: "aaa", role: null }
    const blank: Ss4SignerLink = { contact_id: "bbb", role: "   " }
    const undef: Ss4SignerLink = { contact_id: "ccc" }
    expect(() => pickDefaultSs4SignerLink([nullRole, blank, undef])).not.toThrow()
    expect(pickDefaultSs4SignerLink([nullRole, blank, undef])).toEqual(nullRole)
    // A real owner still beats all three.
    expect(pickDefaultSs4SignerLink([nullRole, blank, undef, owner])).toEqual(owner)
  })

  it("bare 'Member' is a materializer default, so a real owner outranks it", () => {
    const member: Ss4SignerLink = { contact_id: "aaa", role: "Member" }
    expect(pickDefaultSs4SignerLink([member, owner])).toEqual(owner)
  })

  it("does not mutate the caller's array (it is a live query result)", () => {
    const input = [rep, owner]
    const snapshot = [...input]
    pickDefaultSs4SignerLink(input)
    expect(input).toEqual(snapshot)
  })

  it("MUTATION PROOF — a role-blind first-row pick fails these", () => {
    // This is what the code did before the fix: take links[0].
    const naive = (links: Ss4SignerLink[]) => links[0]
    expect(naive([rep, owner])).not.toEqual(pickDefaultSs4SignerLink([rep, owner]))
    // And it is order-dependent, which is exactly why it was unpinnable.
    expect(naive([rep, owner])).not.toEqual(naive([owner, rep]))
    expect(pickDefaultSs4SignerLink([rep, owner])).toEqual(pickDefaultSs4SignerLink([owner, rep]))
  })
})

describe("isOwnerTypeRole", () => {
  it("matches owner-type roles case-insensitively, whole-string only", () => {
    expect(isOwnerTypeRole("owner")).toBe(true)
    expect(isOwnerTypeRole("Owner")).toBe(true)
    expect(isOwnerTypeRole("Sole Member")).toBe(true)
    expect(isOwnerTypeRole(null)).toBe(false)
    expect(isOwnerTypeRole(undefined)).toBe(false)
    expect(isOwnerTypeRole("")).toBe(false)
    expect(isOwnerTypeRole("Member")).toBe(false)
    expect(isOwnerTypeRole("authorized_representative")).toBe(false)
  })

  it("does NOT substring-match (the trap that would misread these two real roles)", () => {
    // Contains "owner" nowhere, but a naive .includes('partner') style rule would
    // have classed this as ownership-ish; and a .includes('owner') rule would
    // wrongly match a hypothetical "Former owner - resigned".
    expect(isOwnerTypeRole("Partner - Tax/NHR Consultant (Portugal)")).toBe(false)
    expect(isOwnerTypeRole("Collaborator - Client Communications (team)")).toBe(false)
    expect(isOwnerTypeRole("Former owner - resigned")).toBe(false)
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
