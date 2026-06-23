/**
 * Unit tests for stripDraftMarkdown — the hard sanitizer that guarantees no
 * markdown/asterisks reach a client in a worker-sent email body or portal message
 * (drafts only; the worker's Slack chat formatting is untouched).
 */

import { describe, it, expect } from "vitest"
import { stripDraftMarkdown } from "@/lib/ai-agent/worker-tools"

describe("stripDraftMarkdown", () => {
  it("unwraps **bold** and *italic* without leaving asterisks", () => {
    expect(stripDraftMarkdown("Hello **John**, your *invoice* is ready.")).toBe(
      "Hello John, your invoice is ready.",
    )
  })

  it("converts line-start markdown bullets to dashes", () => {
    expect(stripDraftMarkdown("Next steps:\n* file the form\n* pay the fee")).toBe(
      "Next steps:\n- file the form\n- pay the fee",
    )
  })

  it("removes any stray asterisks entirely", () => {
    expect(stripDraftMarkdown("Important *note here")).toBe("Important note here")
    expect(stripDraftMarkdown("a * b * c")).toBe("a  b  c")
  })

  it("guarantees zero asterisks remain in the output", () => {
    const samples = [
      "**Bold** and *italic* and a lone * and\n* bullet\n* list",
      "Mix **of** *all* the * things *",
      "no markdown at all",
    ]
    for (const s of samples) {
      expect(stripDraftMarkdown(s)).not.toContain("*")
    }
  })

  it("leaves plain human text unchanged", () => {
    const plain = "Hi Marco,\n\nYour EIN came through today. I'll send the next steps shortly.\n\nBest,\nLuca"
    expect(stripDraftMarkdown(plain)).toBe(plain)
  })

  it("handles empty / falsy input safely", () => {
    expect(stripDraftMarkdown("")).toBe("")
    // @ts-expect-error — defensive: undefined passes through
    expect(stripDraftMarkdown(undefined)).toBe(undefined)
  })
})
