/**
 * The build stamp exists so Antonio can tell, in one glance, which build he is
 * QA-ing (2026-08-12: he lost an hour on a six-hour-old pinned deployment).
 * The label must NEVER render an empty or half-empty string that reads like a
 * real answer — an unstamped build has to announce itself as unknown.
 */
import { describe, it, expect } from "vitest"
import { buildStampLabel } from "@/lib/build-stamp"

describe("buildStampLabel", () => {
  it("joins the commit and the deploy time", () => {
    expect(buildStampLabel("5bbb17c", "Aug 12 21:05")).toBe("5bbb17c · Aug 12 21:05")
  })

  it("keeps the dirty marker visible — a stamped build must not hide uncommitted code", () => {
    expect(buildStampLabel("5bbb17c+dirty", "Aug 12 21:05")).toBe("5bbb17c+dirty · Aug 12 21:05")
  })

  it("says 'build unknown' rather than rendering nothing when the deploy skipped injection", () => {
    expect(buildStampLabel("", "")).toBe("build unknown")
    expect(buildStampLabel("   ", "  ")).toBe("build unknown")
  })

  it("still shows whichever half it has", () => {
    expect(buildStampLabel("5bbb17c", "")).toBe("5bbb17c")
    expect(buildStampLabel("", "Aug 12 21:05")).toBe("Aug 12 21:05")
  })
})
