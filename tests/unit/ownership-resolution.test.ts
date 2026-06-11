import { describe, it, expect } from "vitest"
import { resolveOwnership, sameName, normalizeName } from "@/lib/tax/ownership-resolution"

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

  it("0.5% rounding differences are not conflicts", () => {
    const r = resolveOwnership({
      priorK1s: [{ name: "A B", pct: 33.33 }],
      wizardMembers: [{ name: "A B", pct: 33.4 }, { name: "C D", pct: 66.6 }],
      accountContacts: [],
    })
    expect(r.conflicts).toEqual([])
  })
})
