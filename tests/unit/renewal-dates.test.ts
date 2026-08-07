import { describe, it, expect } from "vitest"
import { deriveRenewalDates, plusOneYear, normalizeStateCode, anniversaryForYear, computeRollForward, resolveFilingForYear } from "@/lib/operations/renewal-dates"

const EMPTY = { ra_renewal_date: null, annual_report_due_date: null, cmra_renewal_date: null }

describe("plusOneYear", () => {
  it("adds one year to a plain date", () => {
    expect(plusOneYear("2026-06-05")).toBe("2027-06-05")
  })
  it("Feb 29 overflows to Mar 1 (matches SD-completion roll-forward convention)", () => {
    expect(plusOneYear("2024-02-29")).toBe("2025-03-01")
  })
  it("year boundaries hold (Dec 31, Jan 1)", () => {
    expect(plusOneYear("2026-12-31")).toBe("2027-12-31")
    expect(plusOneYear("2026-01-01")).toBe("2027-01-01")
  })
})

describe("normalizeStateCode", () => {
  it("maps long names and passes codes through", () => {
    expect(normalizeStateCode("New Mexico")).toBe("NM")
    expect(normalizeStateCode("Wyoming")).toBe("WY")
    expect(normalizeStateCode("florida")).toBe("FL")
    expect(normalizeStateCode("DE")).toBe("DE")
    expect(normalizeStateCode(null)).toBe("")
  })
})

describe("deriveRenewalDates — RA renewal", () => {
  it("formation intake derives from formation_date even when client_since is set", () => {
    const fills = deriveRenewalDates({
      intake: "formation",
      formation_date: "2026-06-05",
      client_since: "2026-01-15", // bulk-editable field; must NOT win for formations
      state_of_formation: "New Mexico",
      existing: EMPTY,
      currentYear: 2026,
    })
    expect(fills.ra_renewal_date).toBe("2027-06-05")
  })

  it("onboarding intake derives from ra_switch_date first, then client_since — never formation_date", () => {
    const a = deriveRenewalDates({
      intake: "onboarding",
      formation_date: "2023-08-10",
      ra_switch_date: "2026-05-01",
      client_since: "2026-04-01",
      state_of_formation: "Wyoming",
      existing: EMPTY,
      currentYear: 2026,
    })
    expect(a.ra_renewal_date).toBe("2027-05-01")

    const b = deriveRenewalDates({
      intake: "onboarding",
      formation_date: "2023-08-10",
      ra_switch_date: null,
      client_since: "2026-04-18",
      state_of_formation: "Delaware",
      existing: EMPTY,
      currentYear: 2026,
    })
    expect(b.ra_renewal_date).toBe("2027-04-18")

    const c = deriveRenewalDates({
      intake: "onboarding",
      formation_date: "2023-08-10", // must NOT be used — would derive an already-past date
      state_of_formation: "Wyoming",
      existing: EMPTY,
      currentYear: 2026,
    })
    expect(c.ra_renewal_date).toBeUndefined()
  })

  it("never overwrites an existing (non-null) date", () => {
    const fills = deriveRenewalDates({
      intake: "formation",
      formation_date: "2026-06-05",
      state_of_formation: "New Mexico",
      existing: { ...EMPTY, ra_renewal_date: "2027-06-05" },
      currentYear: 2026,
    })
    expect(fills.ra_renewal_date).toBeUndefined()
  })

  it("no start date → no RA fill (null stays null, watchdog surfaces it)", () => {
    const fills = deriveRenewalDates({
      intake: "formation",
      formation_date: null,
      state_of_formation: "Florida",
      existing: EMPTY,
      currentYear: 2026,
    })
    expect(fills.ra_renewal_date).toBeUndefined()
  })
})

describe("deriveRenewalDates — annual report per state", () => {
  it("FL → May 1 next year; DE → Jun 1 next year", () => {
    const fl = deriveRenewalDates({ intake: "formation", formation_date: "2026-03-10", state_of_formation: "Florida", existing: EMPTY, currentYear: 2026 })
    expect(fl.annual_report_due_date).toBe("2027-05-01")
    const de = deriveRenewalDates({ intake: "onboarding", formation_date: "2025-05-06", client_since: "2026-03-25", state_of_formation: "Delaware", existing: EMPTY, currentYear: 2026 })
    expect(de.annual_report_due_date).toBe("2027-06-01")
  })
  it("WY → 1st of formation month next year", () => {
    const wy = deriveRenewalDates({ intake: "formation", formation_date: "2026-08-10", state_of_formation: "Wyoming", existing: EMPTY, currentYear: 2026 })
    expect(wy.annual_report_due_date).toBe("2027-08-01")
  })
  it("NM → never sets an annual report date", () => {
    const nm = deriveRenewalDates({ intake: "formation", formation_date: "2026-06-05", state_of_formation: "New Mexico", existing: EMPTY, currentYear: 2026 })
    expect(nm.annual_report_due_date).toBeUndefined()
  })
  it("existing AR date preserved", () => {
    const fills = deriveRenewalDates({
      intake: "onboarding",
      formation_date: "2025-06-03",
      client_since: "2026-05-01",
      state_of_formation: "Wyoming",
      existing: { ...EMPTY, annual_report_due_date: "2027-06-01" },
      currentYear: 2026,
    })
    expect(fills.annual_report_due_date).toBeUndefined()
  })
})

describe("deriveRenewalDates — CMRA", () => {
  it("fills Dec 31 of the current year when null; preserved when set", () => {
    const a = deriveRenewalDates({ intake: "formation", formation_date: "2026-06-05", state_of_formation: "NM", existing: EMPTY, currentYear: 2026 })
    expect(a.cmra_renewal_date).toBe("2026-12-31")
    const b = deriveRenewalDates({ intake: "formation", formation_date: "2026-06-05", state_of_formation: "NM", existing: { ...EMPTY, cmra_renewal_date: "2026-12-31" }, currentYear: 2026 })
    expect(b.cmra_renewal_date).toBeUndefined()
  })
})

describe("deriveRenewalDates — the 9 approved backfills (plan c2d97552 A1)", () => {
  const cases: Array<{ name: string; intake: "formation" | "onboarding"; formation_date: string | null; client_since?: string | null; expected: string }> = [
    { name: "ATCOACHING", intake: "onboarding", formation_date: "2025-05-06", client_since: "2026-03-25", expected: "2027-03-25" },
    { name: "2L Consulting", intake: "onboarding", formation_date: "2025-03-20", client_since: "2026-04-18", expected: "2027-04-18" },
    { name: "Infinity Commerce", intake: "onboarding", formation_date: "2025-06-03", client_since: "2026-05-01", expected: "2027-05-01" },
    { name: "AI Venture Labs", intake: "formation", formation_date: "2026-06-16", expected: "2027-06-16" },
    { name: "Automatiko", intake: "formation", formation_date: "2026-06-17", expected: "2027-06-17" },
    { name: "Numero Uno Social", intake: "formation", formation_date: "2026-06-18", expected: "2027-06-18" },
    { name: "Art of Profit Academy", intake: "formation", formation_date: "2026-06-25", expected: "2027-06-25" },
    { name: "E-commerce Empire New York", intake: "formation", formation_date: "2026-06-26", expected: "2027-06-26" },
    { name: "DoctorGut", intake: "formation", formation_date: "2026-07-09", expected: "2027-07-09" },
  ]
  for (const c of cases) {
    it(`${c.name} → ${c.expected}`, () => {
      const fills = deriveRenewalDates({
        intake: c.intake,
        formation_date: c.formation_date,
        client_since: c.client_since ?? null,
        ra_switch_date: c.intake === "onboarding" ? c.client_since ?? null : null,
        state_of_formation: "X", // state irrelevant for the RA date
        existing: EMPTY,
        currentYear: 2026,
      })
      expect(fills.ra_renewal_date).toBe(c.expected)
    })
  }
})

describe("computeRollForward — filed-year+1 semantics (plan 89c951a7)", () => {
  it("normal cycle: 2026 filing on a 2026-11-07 record → 2027-11-07", () => {
    expect(computeRollForward("2026-11-07", 2026)).toEqual({ action: "roll", next: "2027-11-07" })
  })

  it("TITAN class: stuck 2025-11-07 record, filing FOR 2025 → 2026-11-07 (not absorbed to 2027)", () => {
    expect(computeRollForward("2025-11-07", 2025)).toEqual({ action: "roll", next: "2026-11-07" })
  })

  it("stuck record completed today without explicit year: filing FOR 2026 → future date, no cron resurrection", () => {
    const d = computeRollForward("2025-11-07", 2026)
    expect(d).toEqual({ action: "roll", next: "2027-11-07" })
    expect(d.next > "2026-08-06").toBe(true)
  })

  it("record already rolled (repair ran first): 2027 record, 2026 filing → already_current, never moves backwards", () => {
    expect(computeRollForward("2027-11-07", 2026)).toEqual({ action: "already_current", next: "2027-11-07" })
  })

  it("double completion of the same cycle → second roll is a no-op (idempotent)", () => {
    const first = computeRollForward("2026-11-07", 2026)
    expect(first.action).toBe("roll")
    expect(computeRollForward(first.next, 2026)).toEqual({ action: "already_current", next: first.next })
  })

  it("record MORE than a year behind stays behind after one filing — each owed year needs its own filing", () => {
    const d = computeRollForward("2023-05-01", 2023)
    expect(d).toEqual({ action: "roll", next: "2024-05-01" })
  })

  it("Feb 29 anniversary lands on Mar 1 in a non-leap year", () => {
    expect(anniversaryForYear("2024-02-29", 2025)).toBe("2025-03-01")
    expect(anniversaryForYear("2024-02-29", 2028)).toBe("2028-02-29")
    expect(computeRollForward("2024-02-29", 2024)).toEqual({ action: "roll", next: "2025-03-01" })
  })

  it("REGRESSION: dates in the DST-transition window never drift a day (old setFullYear bug)", () => {
    // new Date("2026-11-07").setFullYear(2027) → 2027-11-06 on a US-timezone
    // machine because Nov 6 2027 is still DST while Nov 6 2026 is not.
    expect(plusOneYear("2026-11-07")).toBe("2027-11-07")
    expect(plusOneYear("2027-03-14")).toBe("2028-03-14")
    expect(anniversaryForYear("2026-11-07", 2027)).toBe("2027-11-07")
  })
})

describe("resolveFilingForYear — council blocker: non-dialog completions must not guess from today", () => {
  it("explicit caller year always wins", () => {
    expect(resolveFilingForYear(2025, "2026-12-15", 2027)).toBe(2025)
  })

  it("December cycle completed in January: SD due-date year wins over the completion year", () => {
    // Old behavior rolled 2026-12-15 → 2028 when completed in Jan 2027.
    expect(resolveFilingForYear(undefined, "2026-12-15", 2027)).toBe(2026)
    expect(computeRollForward("2026-12-15", resolveFilingForYear(undefined, "2026-12-15", 2027)))
      .toEqual({ action: "roll", next: "2027-12-15" })
  })

  it("stale cron SD completed years later: files FOR its own cycle, owed years stay visible", () => {
    // SD due 2025-11-07 completed in 2027 → filing FOR 2025 → record moves to 2026 (still owed), not 2028.
    expect(resolveFilingForYear(undefined, "2025-11-07", 2027)).toBe(2025)
    expect(computeRollForward("2025-11-07", 2025)).toEqual({ action: "roll", next: "2026-11-07" })
  })

  it("SD without a due date falls back to the completion year; garbage dates too", () => {
    expect(resolveFilingForYear(undefined, null, 2027)).toBe(2027)
    expect(resolveFilingForYear(undefined, undefined, 2027)).toBe(2027)
    expect(resolveFilingForYear(undefined, "not-a-date", 2027)).toBe(2027)
  })
})
