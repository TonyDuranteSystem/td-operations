import { describe, it, expect } from "vitest"
import {
  derivePhase,
  derivePhaseEnteredAt,
  RENEWAL_SERVICE_TYPES,
  CLOSURE_SERVICE_TYPES,
  type ActiveSD,
} from "@/lib/case-view/queries"

// ── helpers ──────────────────────────────────────────────

function sd(service_type: string, updated_at = "2026-01-01T00:00:00Z"): ActiveSD {
  return { service_type, updated_at }
}

const noSDs: ActiveSD[] = []

// ═══════════════════════════════════════════════════════
// derivePhase — canonical 5-phase precedence
// (Renewal is a FLAG, not a phase)
// ═══════════════════════════════════════════════════════

describe("derivePhase — Offboarded (terminal, evaluated first)", () => {
  it("Cancelled account → Offboarded regardless of SDs", () => {
    expect(derivePhase("Cancelled", null, [sd("Client Onboarding")])).toBe("Offboarded")
  })

  it("Closed account → Offboarded regardless of SDs", () => {
    expect(derivePhase("Closed", null, [sd("Company Formation")])).toBe("Offboarded")
  })

  it("Cancelled with no SDs → Offboarded", () => {
    expect(derivePhase("Cancelled", null, noSDs)).toBe("Offboarded")
  })

  it("Closed with portal_tier=onboarding → still Offboarded", () => {
    expect(derivePhase("Closed", "onboarding", noSDs)).toBe("Offboarded")
  })
})

describe("derivePhase — Closure (evaluated before Formation)", () => {
  it("Offboarding account status → Closure", () => {
    expect(derivePhase("Offboarding", null, noSDs)).toBe("Closure")
  })

  it("Company Closure SD → Closure", () => {
    expect(derivePhase("Active", null, [sd("Company Closure")])).toBe("Closure")
  })

  it("Client Offboarding SD → Closure", () => {
    expect(derivePhase("Active", null, [sd("Client Offboarding")])).toBe("Closure")
  })

  it("Offboarding status + Formation SD → Closure wins (Closure before Formation)", () => {
    expect(derivePhase("Offboarding", null, [sd("Company Formation")])).toBe("Closure")
  })

  it("Closure SD + Onboarding SD → Closure wins", () => {
    expect(derivePhase("Active", null, [sd("Company Closure"), sd("Client Onboarding")])).toBe("Closure")
  })
})

describe("derivePhase — Formation (evaluated before Onboarding)", () => {
  it("Pending Formation account status → Formation", () => {
    expect(derivePhase("Pending Formation", null, noSDs)).toBe("Formation")
  })

  it("Company Formation SD → Formation", () => {
    expect(derivePhase("Active", null, [sd("Company Formation")])).toBe("Formation")
  })

  it("Pending Formation + Onboarding SD → Formation wins", () => {
    expect(derivePhase("Pending Formation", null, [sd("Client Onboarding")])).toBe("Formation")
  })

  it("Formation SD + portal_tier=onboarding → Formation wins", () => {
    expect(derivePhase("Active", "onboarding", [sd("Company Formation")])).toBe("Formation")
  })
})

describe("derivePhase — Onboarding", () => {
  it("Client Onboarding SD → Onboarding", () => {
    expect(derivePhase("Active", null, [sd("Client Onboarding")])).toBe("Onboarding")
  })

  it("portal_tier=onboarding with no SDs → Onboarding", () => {
    expect(derivePhase("Active", "onboarding", noSDs)).toBe("Onboarding")
  })

  it("portal_tier=onboarding with unrelated SD → Onboarding", () => {
    expect(derivePhase("Active", "onboarding", [sd("Tax Return")])).toBe("Onboarding")
  })

  it("Onboarding SD + Renewal SD → Onboarding (Renewal is a flag, not a phase)", () => {
    expect(derivePhase("Active", null, [sd("Client Onboarding"), sd("State RA Renewal")])).toBe("Onboarding")
  })
})

describe("derivePhase — Active (residual)", () => {
  it("Active account with no SDs → Active", () => {
    expect(derivePhase("Active", null, noSDs)).toBe("Active")
  })

  it("Active account with only renewal SDs → Active", () => {
    expect(derivePhase("Active", null, [sd("State RA Renewal")])).toBe("Active")
  })

  it("Active account with Annual Renewal SD → Active (Renewal is a flag)", () => {
    expect(derivePhase("Active", null, [sd("Annual Renewal")])).toBe("Active")
  })

  it("Active account with State Annual Report SD → Active", () => {
    expect(derivePhase("Active", null, [sd("State Annual Report")])).toBe("Active")
  })

  it("Active account with Tax Return SD → Active", () => {
    expect(derivePhase("Active", null, [sd("Tax Return")])).toBe("Active")
  })

  it("null account status with no SDs → Active", () => {
    expect(derivePhase(null, null, noSDs)).toBe("Active")
  })

  it("Delinquent status (not in precedence) → Active", () => {
    expect(derivePhase("Delinquent", null, noSDs)).toBe("Active")
  })

  it("Suspended status → Active", () => {
    expect(derivePhase("Suspended", null, noSDs)).toBe("Active")
  })
})

describe("derivePhase — Renewal is a FLAG, never a phase", () => {
  for (const renewalType of RENEWAL_SERVICE_TYPES) {
    it(`${renewalType} SD alone → Active, not Renewal phase`, () => {
      expect(derivePhase("Active", null, [sd(renewalType)])).toBe("Active")
    })
  }

  it("Renewal SD + Closure SD → Closure (Renewal does not affect phase precedence)", () => {
    expect(derivePhase("Active", null, [sd("State RA Renewal"), sd("Company Closure")])).toBe("Closure")
  })

  it("Renewal SD + Formation SD → Formation", () => {
    expect(derivePhase("Active", null, [sd("State RA Renewal"), sd("Company Formation")])).toBe("Formation")
  })
})

describe("derivePhase — CLOSURE_SERVICE_TYPES coverage", () => {
  for (const closureType of CLOSURE_SERVICE_TYPES) {
    it(`${closureType} SD → Closure`, () => {
      expect(derivePhase("Active", null, [sd(closureType)])).toBe("Closure")
    })
  }
})

// ═══════════════════════════════════════════════════════
// derivePhaseEnteredAt — approximate phase timestamp
// ═══════════════════════════════════════════════════════

describe("derivePhaseEnteredAt", () => {
  const opened = "2025-01-01T00:00:00Z"
  const acctUpdated = "2025-06-01T00:00:00Z"

  it("Offboarded: returns accountUpdatedAt", () => {
    expect(derivePhaseEnteredAt("Offboarded", acctUpdated, opened, noSDs)).toBe(acctUpdated)
  })

  it("Offboarded: falls back to caseOpenedAt when no accountUpdatedAt", () => {
    expect(derivePhaseEnteredAt("Offboarded", null, opened, noSDs)).toBe(opened)
  })

  it("Closure: returns max updated_at of closure SDs", () => {
    const sds = [sd("Company Closure", "2026-03-01T00:00:00Z"), sd("Client Offboarding", "2026-04-01T00:00:00Z")]
    expect(derivePhaseEnteredAt("Closure", acctUpdated, opened, sds)).toBe("2026-04-01T00:00:00Z")
  })

  it("Closure: falls back to accountUpdatedAt when no closure SDs", () => {
    expect(derivePhaseEnteredAt("Closure", acctUpdated, opened, noSDs)).toBe(acctUpdated)
  })

  it("Formation: returns max updated_at of formation SDs", () => {
    const sds = [sd("Company Formation", "2026-02-15T00:00:00Z")]
    expect(derivePhaseEnteredAt("Formation", acctUpdated, opened, sds)).toBe("2026-02-15T00:00:00Z")
  })

  it("Formation: falls back to accountUpdatedAt when no formation SD", () => {
    expect(derivePhaseEnteredAt("Formation", acctUpdated, opened, noSDs)).toBe(acctUpdated)
  })

  it("Formation: falls back to caseOpenedAt when no formation SD and no accountUpdatedAt", () => {
    expect(derivePhaseEnteredAt("Formation", null, opened, noSDs)).toBe(opened)
  })

  it("Onboarding: returns max updated_at of onboarding SDs", () => {
    const sds = [sd("Client Onboarding", "2026-01-20T00:00:00Z")]
    expect(derivePhaseEnteredAt("Onboarding", acctUpdated, opened, sds)).toBe("2026-01-20T00:00:00Z")
  })

  it("Onboarding: falls back to caseOpenedAt when no onboarding SD (portal_tier path)", () => {
    expect(derivePhaseEnteredAt("Onboarding", acctUpdated, opened, noSDs)).toBe(opened)
  })

  it("Active: always returns caseOpenedAt", () => {
    const sds = [sd("Tax Return", "2026-04-01T00:00:00Z")]
    expect(derivePhaseEnteredAt("Active", acctUpdated, opened, sds)).toBe(opened)
  })

  it("Closure: SD with null updated_at is skipped; falls back to accountUpdatedAt", () => {
    const sds = [{ service_type: "Company Closure", updated_at: null }]
    expect(derivePhaseEnteredAt("Closure", acctUpdated, opened, sds)).toBe(acctUpdated)
  })
})
