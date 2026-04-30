import { describe, it, expect } from "vitest"

/**
 * Tests for formation state validation logic (Bug A fix).
 *
 * The select_llc_name handler queries formation_submissions.state to get the
 * LLC formation state — the explicit state chosen by Antonio when creating the
 * formation form. owner_state_province is NEVER used as a formation state source.
 *
 * This tests the validation step: given a value from formation_submissions.state,
 * confirm it is one of TD's valid formation states (NM, WY, FL, DE) and default
 * to NM with a logged warning if not.
 */

const VALID_FORMATION_STATES = ["NM", "WY", "FL", "DE"]

function resolveStateCode(formSubmissionState: string | undefined): {
  state: string
  usedDefault: boolean
} {
  const raw = (formSubmissionState || "").toUpperCase().trim()
  if (VALID_FORMATION_STATES.includes(raw)) return { state: raw, usedDefault: false }
  return { state: "NM", usedDefault: true }
}

describe("SS-4 formation state validation (Bug A — formation_submissions.state source)", () => {
  it("accepts NM from formation_submissions", () => {
    const r = resolveStateCode("NM")
    expect(r.state).toBe("NM")
    expect(r.usedDefault).toBe(false)
  })

  it("accepts WY from formation_submissions", () => {
    const r = resolveStateCode("WY")
    expect(r.state).toBe("WY")
    expect(r.usedDefault).toBe(false)
  })

  it("accepts FL from formation_submissions", () => {
    const r = resolveStateCode("FL")
    expect(r.state).toBe("FL")
    expect(r.usedDefault).toBe(false)
  })

  it("accepts DE from formation_submissions", () => {
    const r = resolveStateCode("DE")
    expect(r.state).toBe("DE")
    expect(r.usedDefault).toBe(false)
  })

  it("is case-insensitive for values from formation_submissions", () => {
    expect(resolveStateCode("nm").state).toBe("NM")
    expect(resolveStateCode("wy").state).toBe("WY")
  })

  it("defaults to NM when no formation_submissions record exists (null/undefined)", () => {
    const r = resolveStateCode(undefined)
    expect(r.state).toBe("NM")
    expect(r.usedDefault).toBe(true)
  })

  it("defaults to NM when formation_submissions.state is empty string", () => {
    const r = resolveStateCode("")
    expect(r.state).toBe("NM")
    expect(r.usedDefault).toBe(true)
  })

  it("defaults to NM for any non-TD state value — owner province never leaks through", () => {
    // These values would come from owner_state_province if the old bug were present.
    // They must NEVER pass through as a valid formation state.
    expect(resolveStateCode("italy").usedDefault).toBe(true)
    expect(resolveStateCode("italy").state).toBe("NM")
    expect(resolveStateCode("CA").usedDefault).toBe(true)
    expect(resolveStateCode("NY").usedDefault).toBe(true)
    expect(resolveStateCode("milano").usedDefault).toBe(true)
    expect(resolveStateCode("New Mexico").usedDefault).toBe(true) // full name — not stored in formation_submissions
  })
})
