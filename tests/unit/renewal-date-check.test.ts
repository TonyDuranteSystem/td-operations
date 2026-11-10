import { describe, it, expect } from "vitest"
import {
  checkRaDate,
  crmDatesOf,
  expectedRaRenewalDate,
  isRealIsoDate,
  matchesStartAnniversary,
  renewalCheckStart,
  validateCorrectedDate,
} from "@/lib/operations/renewal-date-check"
import { decideRenewalIntake } from "@/lib/operations/renewal-status-loader"

describe("isRealIsoDate", () => {
  it("accepts real dates and rejects impossible ones", () => {
    expect(isRealIsoDate("2026-12-10")).toBe(true)
    expect(isRealIsoDate("2024-02-29")).toBe(true)
    expect(isRealIsoDate("2026-02-29")).toBe(false)
    expect(isRealIsoDate("2026-02-31")).toBe(false)
    expect(isRealIsoDate("2026-13-01")).toBe(false)
    expect(isRealIsoDate("10/12/2026")).toBe(false)
    expect(isRealIsoDate(null)).toBe(false)
    expect(isRealIsoDate(20261210)).toBe(false)
  })
})

describe("expectedRaRenewalDate — next anniversary of the RA start on/after today", () => {
  it("SD Int. case: switched 2026-02-19, asked on 2026-11-10 → 2027-02-19", () => {
    expect(expectedRaRenewalDate("2026-02-19", "2026-11-10")).toBe("2027-02-19")
  })
  it("never the start year itself (a service renews a year in)", () => {
    expect(expectedRaRenewalDate("2026-02-19", "2026-01-01")).toBe("2027-02-19")
  })
  it("switched years ago → the next anniversary still ahead", () => {
    expect(expectedRaRenewalDate("2025-02-13", "2026-11-10")).toBe("2027-02-13")
    expect(expectedRaRenewalDate("2025-02-13", "2026-01-05")).toBe("2026-02-13")
  })
  it("today IS the anniversary → today counts", () => {
    expect(expectedRaRenewalDate("2025-11-10", "2026-11-10")).toBe("2026-11-10")
  })
  it("Feb 29 start rolls to Mar 1 in a non-leap year", () => {
    expect(expectedRaRenewalDate("2024-02-29", "2026-01-01")).toBe("2026-03-01")
    expect(expectedRaRenewalDate("2024-02-29", "2027-06-01")).toBe("2028-02-29")
  })
  it("no start / bad input → null", () => {
    expect(expectedRaRenewalDate(null, "2026-11-10")).toBeNull()
    expect(expectedRaRenewalDate("nonsense", "2026-11-10")).toBeNull()
    expect(expectedRaRenewalDate("2026-02-19", "nonsense")).toBeNull()
  })
})

describe("matchesStartAnniversary", () => {
  it("true on the same month/day in any later year", () => {
    expect(matchesStartAnniversary("2027-02-19", "2026-02-19")).toBe(true)
    expect(matchesStartAnniversary("2031-02-19", "2026-02-19")).toBe(true)
  })
  it("false on the formation anniversary of a company that switched later (SD Int.)", () => {
    expect(matchesStartAnniversary("2026-12-10", "2026-02-19")).toBe(false)
  })
  it("Feb 29 start: the Mar 1 roll counts as a match in a non-leap year", () => {
    expect(matchesStartAnniversary("2026-03-01", "2024-02-29")).toBe(true)
  })
  it("unreadable dates never raise a false alarm", () => {
    expect(matchesStartAnniversary("garbage", "2026-02-19")).toBe(true)
  })
})

describe("renewalCheckStart — Client Since filled = onboarded, empty = we created the company", () => {
  it("Client Since filled → measured from Client Since, never from Formation", () => {
    expect(renewalCheckStart({ client_since: "2026-02-19", formation_date: "2021-12-10" })).toEqual({ date: "2026-02-19", basis: "client_since" })
  })
  it("Client Since empty → we created the company → measured from Formation", () => {
    expect(renewalCheckStart({ client_since: null, formation_date: "2023-12-12" })).toEqual({ date: "2023-12-12", basis: "formation" })
  })
  it("neither recorded → nothing to compare", () => {
    expect(renewalCheckStart({ client_since: null, formation_date: null })).toBeNull()
  })
  it("a Client Since that cannot be read never falls back to Formation (that is the mistake this check catches)", () => {
    expect(renewalCheckStart({ client_since: "not a date", formation_date: "2021-12-10" })).toBeNull()
  })
})

describe("checkRaDate", () => {
  const SINCE = { date: "2026-02-19", basis: "client_since" as const }
  it("SD Int.: flags the mismatch and suggests 2027-02-19", () => {
    const r = checkRaDate("2026-12-10", SINCE, "2026-11-10")
    expect(r).toEqual({ matches: false, expected: "2027-02-19", start: "2026-02-19", basis: "client_since" })
  })
  it("a correct date is a match", () => {
    expect(checkRaDate("2027-02-19", SINCE, "2026-11-10")?.matches).toBe(true)
  })
  it("a company we created is checked against its Formation anniversary", () => {
    const f = { date: "2023-12-12", basis: "formation" as const }
    expect(checkRaDate("2026-12-12", f, "2026-11-10")).toEqual({ matches: true, expected: "2026-12-12", start: "2023-12-12", basis: "formation" })
    expect(checkRaDate("2026-12-20", f, "2026-11-10")?.matches).toBe(false)
  })
  it("nothing to judge without a stored date or a start", () => {
    expect(checkRaDate(null, SINCE, "2026-11-10")).toBeNull()
    expect(checkRaDate("2026-12-10", null, "2026-11-10")).toBeNull()
  })
})

describe("crmDatesOf — every date the CRM holds, as shown in the pop-up", () => {
  it("maps each account column and turns missing ones into null", () => {
    const d = crmDatesOf({
      formation_date: "2021-12-10", onboarding_date: "2026-02-19", client_since: "2026-02-19", ra_switch_date: "2026-02-19",
      portal_created_date: "2026-04-09", ra_renewal_date: "2026-12-10",
    })
    expect(d).toEqual({
      formation: "2021-12-10", onboarding: "2026-02-19", clientSince: "2026-02-19", raSwitch: "2026-02-19", portalCreated: "2026-04-09",
      raRenewal: "2026-12-10", mailingAddress: null, setupFee: null, setupFeePaid: null,
      cancellation: null, remindersPausedUntil: null,
    })
  })
  it("an account row without the optional columns still works", () => {
    expect(crmDatesOf({}).clientSince).toBeNull()
  })
})

describe("validateCorrectedDate", () => {
  const TODAY = "2026-11-10"
  it("accepts a sensible date", () => {
    expect(validateCorrectedDate("2027-02-19", TODAY)).toBeNull()
    expect(validateCorrectedDate("2025-03-01", TODAY)).toBeNull() // a record behind is allowed
  })
  it("rejects impossible and far-off dates (typos)", () => {
    expect(validateCorrectedDate("2027-02-30", TODAY)).toMatch(/real date/)
    expect(validateCorrectedDate("2062-02-19", TODAY)).toMatch(/far from today/)
    expect(validateCorrectedDate("2020-02-19", TODAY)).toMatch(/far from today/)
    expect(validateCorrectedDate(undefined, TODAY)).toMatch(/real date/)
  })
})

describe("decideRenewalIntake — Antonio's rule: Client Since filled = onboarded, empty = we created it", () => {
  it("Client Since filled → onboarding, even with a Company Formation job (legacy onboardings have one) or a switch date", () => {
    expect(decideRenewalIntake({ hasFormationJob: true, formation_date: "2021-12-10", client_since: "2026-02-19" })).toBe("onboarding")
    expect(decideRenewalIntake({ hasFormationJob: false, formation_date: null, client_since: "2026-02-19" })).toBe("onboarding")
  })
  it("Client Since empty → formation (we created the company)", () => {
    expect(decideRenewalIntake({ hasFormationJob: false, formation_date: "2023-12-12", client_since: null })).toBe("formation")
    expect(decideRenewalIntake({ hasFormationJob: true, formation_date: null, client_since: null })).toBe("formation")
  })
  it("nothing at all recorded → null (never guess)", () => {
    expect(decideRenewalIntake({ hasFormationJob: false, formation_date: null, client_since: null })).toBeNull()
  })
})
