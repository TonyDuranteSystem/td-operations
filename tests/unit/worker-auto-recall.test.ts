import { describe, it, expect } from "vitest"
import { formatRecalledLessons, AUTO_RECALL_THRESHOLD, AUTO_RECALL_COUNT } from "@/lib/ai-agent/worker-tools"

describe("formatRecalledLessons (Decision Memory auto-recall)", () => {
  it("returns empty string for no matches", () => {
    expect(formatRecalledLessons([])).toBe("")
  })

  it("formats a single lesson without domain or reasoning", () => {
    expect(formatRecalledLessons([{ decision: "Verify facts before replying", domain: null, reasoning: null }])).toBe(
      "- Verify facts before replying",
    )
  })

  it("prefixes the domain bucket when present", () => {
    expect(
      formatRecalledLessons([{ decision: "Use precise regulatory terms", domain: "compliance", reasoning: null }]),
    ).toBe("- [compliance] Use precise regulatory terms")
  })

  it("appends the reasoning as a why-clause when present", () => {
    expect(
      formatRecalledLessons([
        { decision: "Differentiate emails by lifecycle stage", domain: "billing", reasoning: "one template misleads" },
      ]),
    ).toBe("- [billing] Differentiate emails by lifecycle stage (why: one template misleads)")
  })

  it("joins multiple lessons with newlines, one bullet each", () => {
    const out = formatRecalledLessons([
      { decision: "A", domain: null, reasoning: null },
      { decision: "B", domain: "x", reasoning: null },
    ])
    expect(out).toBe("- A\n- [x] B")
    expect(out.split("\n")).toHaveLength(2)
  })

  it("exposes sane tuning constants (looser than the 0.7 explicit-recall default)", () => {
    expect(AUTO_RECALL_THRESHOLD).toBeGreaterThan(0)
    expect(AUTO_RECALL_THRESHOLD).toBeLessThan(0.7)
    expect(AUTO_RECALL_COUNT).toBeGreaterThanOrEqual(1)
  })
})
