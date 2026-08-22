import { describe, it, expect } from "vitest"
import { resolveOwnership, sameName, normalizeName, ownershipIsBroken, describeBrokenOwnership } from "@/lib/tax/ownership-resolution"

describe("name matching", () => {
  it("normalizes case, accents, punctuation", () => {
    expect(normalizeName("  Sofìa   MARINONI ")).toBe("sof a marinoni".replace("sof a", "sofia")) // accent stripped
    expect(sameName("Sofia Marinoni", "SOFIA MARINONI")).toBe(true)
    expect(sameName("Sofia Marinoni", "Sofia A. Marinoni")).toBe(true)
    expect(sameName("Sofia Marinoni", "Marco Bianchi")).toBe(false)
    expect(sameName("Sofia", "Sofia Marinoni")).toBe(false) // single token never matches
  })
})

describe("resolveOwnership (W6 precedence)", () => {
  it("prior K-1 beats wizard beats CRM, and flags the conflict", () => {
    const r = resolveOwnership({
      priorK1s: [{ name: "Sofia Marinoni", pct: 60 }],
      wizardMembers: [{ name: "Sofia Marinoni", pct: 55 }, { name: "Marco Bianchi", pct: 40 }],
      accountContacts: [{ name: "Marco Bianchi", pct: 45, contact_id: "c-marco" }],
    })
    const sofia = r.members.find(m => m.name === "Sofia Marinoni")!
    const marco = r.members.find(m => m.name === "Marco Bianchi")!
    expect(sofia.pct).toBe(60)
    expect(sofia.source).toBe("prior_k1")
    expect(marco.pct).toBe(40) // wizard beats account_contacts
    expect(marco.source).toBe("wizard")
    expect(marco.contact_id).toBe("c-marco") // sync-back target preserved
    expect(r.conflicts.map(c => c.name).sort()).toEqual(["Marco Bianchi", "Sofia Marinoni"])
    expect(r.complete).toBe(true) // 60 + 40 = 100
  })

  it("merges the same person across sources by normalized name", () => {
    const r = resolveOwnership({
      priorK1s: [{ name: "SOFIA MARINONI", pct: 50 }],
      wizardMembers: [{ name: "Sofia Marinoni", pct: 50 }],
      accountContacts: [{ name: "Sofia A. Marinoni", pct: null, contact_id: "c-1" }],
    })
    expect(r.members).toHaveLength(1)
    expect(r.members[0].contact_id).toBe("c-1")
    expect(r.conflicts).toEqual([]) // same value everywhere it's stated
  })

  it("reports missing % and incomplete totals", () => {
    const r = resolveOwnership({
      priorK1s: [],
      wizardMembers: [{ name: "Sofia Marinoni", pct: 60 }, { name: "Marco Bianchi", pct: null }],
      accountContacts: [],
    })
    expect(r.missing).toEqual(["Marco Bianchi"])
    expect(r.complete).toBe(false)
  })

  it("totals off 100 → incomplete even with all percentages present", () => {
    const r = resolveOwnership({
      priorK1s: [],
      wizardMembers: [{ name: "A B", pct: 60 }, { name: "C D", pct: 30 }],
      accountContacts: [],
    })
    expect(r.totalPct).toBe(90)
    expect(r.complete).toBe(false)
  })

  it("the wizard list IS the roster — a CRM contact not declared never becomes a member (Antonio's 200% case)", () => {
    const r = resolveOwnership({
      priorK1s: [],
      wizardMembers: [{ name: "Sofia Marinoni", pct: 50 }, { name: "Donato Renato Berini", pct: 50 }],
      accountContacts: [{ name: "Uxio Test", pct: 100, contact_id: "c-uxio" }],
    })
    expect(r.members.map(m => m.name).sort()).toEqual(["Donato Renato Berini", "Sofia Marinoni"])
    expect(r.totalPct).toBe(100)
    expect(r.complete).toBe(true) // the declared roster is complete — K-1s unblocked
    // …but the undeclared person is a conflict: staff see it, and the auto
    // sync-back to the CRM is held (sync requires zero conflicts).
    expect(r.conflicts.some(c => c.name === "Uxio Test" && c.message.includes("NOT in this year's member list"))).toBe(true)
  })

  it("a prior-K-1 partner missing from this year's list is flagged (possible exit), never auto-added", () => {
    const r = resolveOwnership({
      priorK1s: [{ name: "Old Partner", pct: 30 }, { name: "Sofia Marinoni", pct: 70 }],
      wizardMembers: [{ name: "Sofia Marinoni", pct: 100 }],
      accountContacts: [],
    })
    expect(r.members.map(m => m.name)).toEqual(["Sofia Marinoni"])
    expect(r.members[0].pct).toBe(70) // prior K-1 still wins precedence for a DECLARED member
    expect(r.conflicts.some(c => c.name === "Old Partner" && c.message.includes("exited"))).toBe(true)
  })

  it("without a wizard list (staff context), all sources merge as before", () => {
    const r = resolveOwnership({
      priorK1s: [],
      wizardMembers: [],
      accountContacts: [{ name: "Uxio Test", pct: 100, contact_id: "c-uxio" }],
    })
    expect(r.members.map(m => m.name)).toEqual(["Uxio Test"])
    expect(r.complete).toBe(true)
  })

  it("0.5% rounding differences are not conflicts", () => {
    const r = resolveOwnership({
      priorK1s: [{ name: "A B", pct: 33.33 }],
      wizardMembers: [{ name: "A B", pct: 33.4 }, { name: "C D", pct: 66.6 }],
      accountContacts: [],
    })
    expect(r.conflicts).toEqual([])
  })
})

describe("ownershipIsBroken / describeBrokenOwnership (2026-08-22, round-5)", () => {
  // The exact real-world shape that shipped broken: two members BOTH entered
  // at 60% (120% total) — this is what a real client (MPG Performance LLC)
  // already attested a return with.
  it("two members entered at 60%/60% is BROKEN — names and the total in the message", () => {
    const r = resolveOwnership({
      priorK1s: [],
      wizardMembers: [{ name: "Alice Member", pct: 60 }, { name: "Bob Member", pct: 60 }],
      accountContacts: [],
    })
    expect(ownershipIsBroken(r)).toBe(true)
    const msg = describeBrokenOwnership(r)
    expect(msg).not.toBeNull()
    expect(msg).toContain("120")
    expect(msg).toContain("Alice Member (60%)")
    expect(msg).toContain("Bob Member (60%)")
    expect(msg).toMatch(/fix the ownership/i)
  })

  it("a brand-new entity with ZERO members is NOT broken — still being set up, not wrong", () => {
    const r = resolveOwnership({ priorK1s: [], wizardMembers: [], accountContacts: [] })
    expect(ownershipIsBroken(r)).toBe(false)
    expect(describeBrokenOwnership(r)).toBeNull()
  })

  // The SMLLC / legacy-wizard shape (bug-hunter round-5 finding): the one
  // owner has no % anywhere (the legacy wizard step never asked for it, and
  // nothing infers it as the remainder) — this must land as "missing", never
  // as a wrong sum, or a single-owner entity would be permanently locked out.
  it("a single owner with NO percentage anywhere is NOT broken — missing, not wrong", () => {
    const r = resolveOwnership({
      priorK1s: [],
      wizardMembers: [{ name: "Solo Owner", pct: null }],
      accountContacts: [],
    })
    expect(r.missing).toEqual(["Solo Owner"])
    expect(ownershipIsBroken(r)).toBe(false)
    expect(describeBrokenOwnership(r)).toBeNull()
  })

  // A name-mismatch between sources (e.g. a nickname or accented spelling)
  // makes the resolver treat two people as one unmatched, missing entry —
  // it must never be mistaken for a wrong SUM, which requires everyone to
  // already have a resolved percentage.
  it("a partially-entered roster (one member still missing) is NOT broken, even though the total is off", () => {
    const r = resolveOwnership({
      priorK1s: [],
      wizardMembers: [{ name: "Alice Member", pct: 60 }, { name: "Bob Member", pct: null }],
      accountContacts: [],
    })
    expect(r.missing).toEqual(["Bob Member"])
    expect(ownershipIsBroken(r)).toBe(false)
    expect(describeBrokenOwnership(r)).toBeNull()
  })

  it("a correct 100% split is NOT broken", () => {
    const r = resolveOwnership({
      priorK1s: [],
      wizardMembers: [{ name: "Alice Member", pct: 60 }, { name: "Bob Member", pct: 40 }],
      accountContacts: [],
    })
    expect(ownershipIsBroken(r)).toBe(false)
    expect(describeBrokenOwnership(r)).toBeNull()
  })

  it("three members entered but summing to 90% is broken too (not just over 100)", () => {
    const r = resolveOwnership({
      priorK1s: [],
      wizardMembers: [{ name: "A", pct: 30 }, { name: "B", pct: 30 }, { name: "C", pct: 30 }],
      accountContacts: [],
    })
    expect(ownershipIsBroken(r)).toBe(true)
    expect(describeBrokenOwnership(r)).toContain("90")
  })
})
