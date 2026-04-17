/**
 * P3.4 #3 — ContactHealthPanel helpers unit tests.
 *
 * Covers: combineSummaries (additive rollup of both diagnose endpoints)
 * and rollupStatus (worst-status wins: error > warning > info > ok).
 *
 * The full component is a React-heavy orchestrator; its networked logic
 * is exercised via browser QA. These tests pin the pure helpers.
 */

import { describe, it, expect } from "vitest"
import { combineSummaries, rollupStatus } from "@/lib/contact-health-helpers"

describe("combineSummaries", () => {
  it("sums two summary objects component-wise", () => {
    const a = { ok: 3, warning: 1, error: 0, info: 2, total: 6 }
    const b = { ok: 1, warning: 2, error: 4, info: 0, total: 7 }
    expect(combineSummaries(a, b)).toEqual({ ok: 4, warning: 3, error: 4, info: 2, total: 13 })
  })

  it("handles undefined sides by treating them as zero", () => {
    const a = { ok: 2, warning: 0, error: 1, info: 0, total: 3 }
    expect(combineSummaries(a, undefined)).toEqual(a)
    expect(combineSummaries(undefined, a)).toEqual(a)
    expect(combineSummaries(undefined, undefined)).toEqual({ ok: 0, warning: 0, error: 0, info: 0, total: 0 })
  })
})

describe("rollupStatus", () => {
  it("returns 'empty' for no checks", () => {
    expect(rollupStatus([])).toBe("empty")
  })

  it("returns 'error' when any check errors", () => {
    expect(
      rollupStatus([
        { id: "1", category: "x", label: "a", status: "ok", detail: "" },
        { id: "2", category: "x", label: "b", status: "warning", detail: "" },
        { id: "3", category: "x", label: "c", status: "error", detail: "" },
      ]),
    ).toBe("error")
  })

  it("returns 'warning' when warnings exist but no errors", () => {
    expect(
      rollupStatus([
        { id: "1", category: "x", label: "a", status: "ok", detail: "" },
        { id: "2", category: "x", label: "b", status: "warning", detail: "" },
        { id: "3", category: "x", label: "c", status: "info", detail: "" },
      ]),
    ).toBe("warning")
  })

  it("returns 'info' when only info + ok", () => {
    expect(
      rollupStatus([
        { id: "1", category: "x", label: "a", status: "ok", detail: "" },
        { id: "2", category: "x", label: "b", status: "info", detail: "" },
      ]),
    ).toBe("info")
  })

  it("returns 'ok' when all checks are ok", () => {
    expect(
      rollupStatus([
        { id: "1", category: "x", label: "a", status: "ok", detail: "" },
        { id: "2", category: "x", label: "b", status: "ok", detail: "" },
      ]),
    ).toBe("ok")
  })
})
