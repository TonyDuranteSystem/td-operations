/**
 * P3.7 — lib/operations/destructive.ts unit tests
 *
 * Covers the pure helpers behind the destructive-action dry-run contract.
 */

import { describe, expect, it } from "vitest"
import {
  formatAffected,
  totalAffected,
  type DryRunResult,
} from "@/lib/operations/destructive"

describe("totalAffected", () => {
  it("sums all counts", () => {
    const r: DryRunResult = {
      affected: { contracts: 2, activations: 1, portal_user: 1 },
      items: [],
    }
    expect(totalAffected(r)).toBe(4)
  })

  it("returns 0 for empty affected", () => {
    const r: DryRunResult = { affected: {}, items: [] }
    expect(totalAffected(r)).toBe(0)
  })

  it("ignores zero counts", () => {
    const r: DryRunResult = {
      affected: { contracts: 0, activations: 0 },
      items: [],
    }
    expect(totalAffected(r)).toBe(0)
  })
})

describe("formatAffected", () => {
  it("joins non-zero entries with commas", () => {
    expect(formatAffected({ contracts: 2, activations: 1 })).toBe(
      "2 contracts, 1 activations",
    )
  })

  it("replaces underscores with spaces for readability", () => {
    expect(formatAffected({ portal_user: 1, pending_activations: 3 })).toBe(
      "1 portal user, 3 pending activations",
    )
  })

  it("filters out zero counts", () => {
    expect(formatAffected({ contracts: 0, activations: 2 })).toBe("2 activations")
  })

  it("returns fallback text when nothing affected", () => {
    expect(formatAffected({})).toBe("no related records")
    expect(formatAffected({ offers: 0 })).toBe("no related records")
  })
})
