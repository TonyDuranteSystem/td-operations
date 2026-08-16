import { describe, it, expect, vi } from "vitest"

let txCount = 0
let mockView: {
  draft: { beginning_cash: number | null; ending_cash: number; ending_cta: number; members: Array<{ name: string; ending_capital: number }> }
  gates: Array<{ id: number; status: string }>
  ownership: { complete: boolean; members: Array<{ name: string; contact_id: string | null }> }
} = {
  draft: { beginning_cash: 391863.70, ending_cash: 391863.70, ending_cta: 0, members: [] },
  gates: [{ id: 1, status: "pass" }, { id: 3, status: "pass" }, { id: 5, status: "pass" }],
  ownership: { complete: true, members: [] },
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ count: txCount }),
        }),
      }),
    }),
  },
}))

vi.mock("@/lib/tax/financials-orchestration", () => ({
  getFinancialsView: vi.fn(async () => mockView),
}))

import { computeCarryFromBooks, autoCarryMayReplace, validateCorrectionPayload } from "@/lib/tax/prior-return-correction"
import type { ResolvedMember } from "@/lib/tax/ownership-resolution"

const member = (name: string, contact_id: string | null): ResolvedMember => ({ name, pct: 50, source: "account_contacts", contact_id })

describe("computeCarryFromBooks (dev_task d909e086)", () => {
  it("refuses when there are no prior-year transactions at all", async () => {
    txCount = 0
    const r = await computeCarryFromBooks("acct", 2025, [member("Sofia Marinoni", "c1")])
    expect(r.offered).toBe(false)
    expect(r.reason).toContain("No transactions on file")
  })

  it("refuses when gate 1 (reconciliation) fails", async () => {
    txCount = 5
    mockView = { ...mockView, gates: [{ id: 1, status: "fail" }, { id: 3, status: "pass" }, { id: 5, status: "pass" }] }
    const r = await computeCarryFromBooks("acct", 2025, [member("Sofia Marinoni", "c1")])
    expect(r.offered).toBe(false)
    expect(r.reason).toContain("reconciliation")
  })

  it("refuses when gate 3 (balance sheet) is not a clean pass", async () => {
    txCount = 5
    mockView = { ...mockView, gates: [{ id: 1, status: "pass" }, { id: 3, status: "fail" }, { id: 5, status: "pass" }] }
    const r = await computeCarryFromBooks("acct", 2025, [member("Sofia Marinoni", "c1")])
    expect(r.offered).toBe(false)
    expect(r.reason).toContain("balance sheet")
  })

  it("refuses when ownership isn't fully resolved (gate 5 fail OR ownership.complete false) — round-3 major finding", async () => {
    txCount = 5
    mockView = { ...mockView, gates: [{ id: 1, status: "pass" }, { id: 3, status: "pass" }, { id: 5, status: "fail" }], ownership: { complete: false, members: [] } }
    const r = await computeCarryFromBooks("acct", 2025, [member("Sofia Marinoni", "c1")])
    expect(r.offered).toBe(false)
    expect(r.reason).toContain("ownership")
  })

  it("refuses when there's no resolved beginning cash to carry", async () => {
    txCount = 5
    mockView = {
      draft: { beginning_cash: null, ending_cash: 0, ending_cta: 0, members: [] },
      gates: [{ id: 1, status: "pass" }, { id: 3, status: "pass" }, { id: 5, status: "pass" }],
      ownership: { complete: true, members: [{ name: "Sofia Marinoni", contact_id: "c1" }] },
    }
    const r = await computeCarryFromBooks("acct", 2025, [member("Sofia Marinoni", "c1")])
    expect(r.offered).toBe(false)
  })

  it("offers a candidate when trustworthy, matching by contact_id first", async () => {
    txCount = 5
    mockView = {
      draft: { beginning_cash: 391863.70, ending_cash: 391863.70, ending_cta: -50, members: [{ name: "Sofia Marinoni", ending_capital: 216862.38 }] },
      gates: [{ id: 1, status: "pass" }, { id: 3, status: "pass" }, { id: 5, status: "pass" }],
      ownership: { complete: true, members: [{ name: "Sofia Marinoni", contact_id: "c1" }] },
    }
    // Current year's member has a slightly different display name — id match still finds it.
    const r = await computeCarryFromBooks("acct", 2025, [member("Sofia A. Marinoni", "c1")])
    expect(r.offered).toBe(true)
    expect(r.candidate?.case).toBe("carried_forward")
    if (r.candidate?.case !== "carried_forward") throw new Error("narrowing")
    expect(r.candidate.beginning_cta).toBe(-50)
    expect(r.candidate.extracted.k1s[0].ending_capital).toBeCloseTo(216862.38, 2)
    expect(r.candidate.unresolved_members).toEqual([])
  })

  it("falls back to name matching when contact_id is unavailable on either side", async () => {
    txCount = 5
    mockView = {
      draft: { beginning_cash: 391863.70, ending_cash: 391863.70, ending_cta: 0, members: [{ name: "Sofia Marinoni", ending_capital: 216862.38 }] },
      gates: [{ id: 1, status: "pass" }, { id: 3, status: "pass" }, { id: 5, status: "pass" }],
      ownership: { complete: true, members: [{ name: "Sofia Marinoni", contact_id: null }] },
    }
    const r = await computeCarryFromBooks("acct", 2025, [member("Sofia Marinoni", null)])
    expect(r.offered).toBe(true)
    if (r.candidate?.case !== "carried_forward") throw new Error("narrowing")
    expect(r.candidate.member_links[0].beginning_capital).toBeCloseTo(216862.38, 2)
  })

  it("a current member matching neither id nor name lands in unresolved_members, never silently 0 with no signal", async () => {
    txCount = 5
    mockView = {
      draft: { beginning_cash: 391863.70, ending_cash: 391863.70, ending_cta: 0, members: [{ name: "Sofia Marinoni", ending_capital: 216862.38 }] },
      gates: [{ id: 1, status: "pass" }, { id: 3, status: "pass" }, { id: 5, status: "pass" }],
      ownership: { complete: true, members: [{ name: "Sofia Marinoni", contact_id: "c1" }] },
    }
    const r = await computeCarryFromBooks("acct", 2025, [member("Sofia Marinoni", "c1"), member("Brand New Partner", "c9")])
    expect(r.offered).toBe(true)
    if (r.candidate?.case !== "carried_forward") throw new Error("narrowing")
    expect(r.candidate.unresolved_members).toEqual(["Brand New Partner"])
    expect(r.candidate.extracted.k1s.some(k => k.partner_name === "Brand New Partner")).toBe(false)
  })

  it("round-4 bug-hunter major: a name-superset collision never lets two current members claim the same prior member's capital", async () => {
    txCount = 5
    mockView = {
      draft: { beginning_cash: 100000, ending_cash: 100000, ending_cta: 0, members: [{ name: "Maria Rossi", ending_capital: 50000 }] },
      gates: [{ id: 1, status: "pass" }, { id: 3, status: "pass" }, { id: 5, status: "pass" }],
      ownership: { complete: true, members: [{ name: "Maria Rossi", contact_id: null }] },
    }
    // "Maria Rossi Bianchi" is a genuinely NEW member this year — sameName's
    // subset rule would otherwise match her to the SAME prior "Maria Rossi".
    const r = await computeCarryFromBooks("acct", 2025, [member("Maria Rossi", null), member("Maria Rossi Bianchi", null)])
    expect(r.offered).toBe(true)
    if (r.candidate?.case !== "carried_forward") throw new Error("narrowing")
    // Exactly one member gets the $50,000 — never both.
    expect(r.candidate.member_links).toHaveLength(1)
    expect(r.candidate.member_links[0].name).toBe("Maria Rossi")
    expect(r.candidate.member_links[0].beginning_capital).toBe(50000)
    expect(r.candidate.unresolved_members).toEqual(["Maria Rossi Bianchi"])
  })

  it("the exact match wins regardless of array order — the exact-name member is never bumped by a fuzzy subset match that happens to iterate first", async () => {
    txCount = 5
    mockView = {
      draft: { beginning_cash: 100000, ending_cash: 100000, ending_cta: 0, members: [{ name: "Maria Rossi", ending_capital: 50000 }] },
      gates: [{ id: 1, status: "pass" }, { id: 3, status: "pass" }, { id: 5, status: "pass" }],
      ownership: { complete: true, members: [{ name: "Maria Rossi", contact_id: null }] },
    }
    // Superset name listed FIRST this time.
    const r = await computeCarryFromBooks("acct", 2025, [member("Maria Rossi Bianchi", null), member("Maria Rossi", null)])
    expect(r.offered).toBe(true)
    if (r.candidate?.case !== "carried_forward") throw new Error("narrowing")
    expect(r.candidate.member_links).toEqual([{ contact_id: null, name: "Maria Rossi", beginning_capital: 50000 }])
    expect(r.candidate.unresolved_members).toEqual(["Maria Rossi Bianchi"])
  })

  it("round-5 bug-hunter major: a duplicate contact_id (a real data-integrity condition on account_contacts) never lets two current members claim the same prior member via the contact_id pass either — the guard passes 2/3 had was missing from pass 1", async () => {
    txCount = 5
    mockView = {
      draft: { beginning_cash: 100000, ending_cash: 100000, ending_cta: 0, members: [{ name: "Paolo Neri", ending_capital: 75000 }] },
      gates: [{ id: 1, status: "pass" }, { id: 3, status: "pass" }, { id: 5, status: "pass" }],
      ownership: { complete: true, members: [{ name: "Paolo Neri", contact_id: "shared-id" }] },
    }
    // Two DIFFERENT current members mistakenly sharing one contact_id.
    const r = await computeCarryFromBooks("acct", 2025, [member("Paolo Neri", "shared-id"), member("Paolo N. Rossi", "shared-id")])
    expect(r.offered).toBe(true)
    if (r.candidate?.case !== "carried_forward") throw new Error("narrowing")
    expect(r.candidate.member_links).toHaveLength(1)
    expect(r.candidate.member_links[0].beginning_capital).toBe(75000)
    expect(r.candidate.unresolved_members).toHaveLength(1)
  })
})

describe("autoCarryMayReplace (round-2 precedence finding)", () => {
  it("allows replacing absent / failed / we_filed-on_file", () => {
    expect(autoCarryMayReplace(null)).toBe(true)
    expect(autoCarryMayReplace({ case: "filed_elsewhere", status: "failed", error: "x", recorded_at: "z" })).toBe(true)
    expect(autoCarryMayReplace({ case: "we_filed", status: "on_file", tax_return_id: null, note: "", recorded_at: "z" })).toBe(true)
  })
  it("refuses to replace anything already authoritative — a validated upload, a first_year/never_filed declaration, or a standing carried_forward/staff_corrected", () => {
    expect(autoCarryMayReplace({ case: "filed_elsewhere", status: "validated", extracted: {} as never, issues: [], source: "x", extracted_at: "z" })).toBe(false)
    expect(autoCarryMayReplace({ case: "first_year", status: "first_year", formation_date: null, note: "", recorded_at: "z" })).toBe(false)
    expect(autoCarryMayReplace({ case: "never_filed", status: "never_filed", cleanup_interest: "No", declaration_accepted: true, recorded_at: "z" })).toBe(false)
  })
})

describe("validateCorrectionPayload (round-2 finding: no field may be silently defaulted)", () => {
  it("rejects a missing beginning_cash", () => {
    const r = validateCorrectionPayload({ beginning_cta: 0, members: [{ name: "X", beginning_capital: 0 }] })
    expect(r.ok).toBe(false)
  })
  it("rejects a missing beginning_cta — 0 must be typed explicitly, never assumed", () => {
    const r = validateCorrectionPayload({ beginning_cash: 100, members: [{ name: "X", beginning_capital: 0 }] })
    expect(r.ok).toBe(false)
  })
  it("rejects an empty members array", () => {
    const r = validateCorrectionPayload({ beginning_cash: 100, beginning_cta: 0, members: [] })
    expect(r.ok).toBe(false)
  })
  it("rejects a member missing beginning_capital", () => {
    const r = validateCorrectionPayload({ beginning_cash: 100, beginning_cta: 0, members: [{ name: "X" }] })
    expect(r.ok).toBe(false)
  })
  it("accepts a fully-specified payload, including an explicit 0", () => {
    const r = validateCorrectionPayload({ beginning_cash: 100, beginning_cta: 0, members: [{ name: "X", beginning_capital: 0, contact_id: null }] })
    expect(r.ok).toBe(true)
  })
})
