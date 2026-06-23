/**
 * Persistent worker memory — Phase 2: semantic cross-thread recall.
 * Pure-unit coverage for the composition + formatting + guards in
 * lib/ai-agent/thread-recall.ts. The embedding + RPC paths are network/DB-bound
 * (OpenAI + match_thread_summaries) and exercised in sandbox, not here.
 */

import { describe, it, expect } from "vitest"
import {
  composeThreadEmbeddingText,
  formatRelatedThreadsSuffix,
  recallRelatedThreads,
  embedThreadSummary,
  buildRelatedThreadsSuffix,
  semanticRecallEnabled,
  type RelatedThreadMatch,
} from "@/lib/ai-agent/thread-recall"

describe("composeThreadEmbeddingText", () => {
  it("combines title, tags, outcome and summary into one block", () => {
    const text = composeThreadEmbeddingText({
      title: "Gritti invoice question",
      tags: ["billing", "installment"],
      outcome: "investigation_complete",
      summary_text: "Confirmed the second installment was not yet paid.",
    })
    expect(text).toContain("Gritti invoice question")
    expect(text).toContain("Topics: billing, installment")
    expect(text).toContain("Outcome: investigation_complete")
    expect(text).toContain("second installment")
  })

  it("returns empty string when there is nothing meaningful to embed", () => {
    expect(composeThreadEmbeddingText({})).toBe("")
    expect(composeThreadEmbeddingText({ title: null, tags: [], outcome: null, summary_text: null })).toBe("")
  })

  it("works with only a summary", () => {
    expect(composeThreadEmbeddingText({ summary_text: "just a summary" })).toBe("just a summary")
  })
})

describe("formatRelatedThreadsSuffix", () => {
  it("returns '' for no matches (no block injected when nothing is related)", () => {
    expect(formatRelatedThreadsSuffix([])).toBe("")
  })

  it("renders a labeled block with title, date, summary and a relatedness %", () => {
    const matches: RelatedThreadMatch[] = [
      {
        thread_id: "t1",
        thread_type: "investigation",
        title: "WhatsApp migration",
        outcome: "investigation_complete",
        summary_text: "Discussed migrating the number to WABA and importing chats.",
        tags: ["whatsapp"],
        created_at: "2026-03-15T10:00:00Z",
        similarity: 0.83,
      },
    ]
    const out = formatRelatedThreadsSuffix(matches)
    expect(out).toContain("RELATED PAST CONVERSATIONS")
    expect(out).toContain("WhatsApp migration")
    expect(out).toContain("(2026-03-15)")
    expect(out).toContain("migrating the number to WABA")
    expect(out).toContain("83% related")
    // includes the "verify before relying / don't assume" guardrail
    expect(out.toLowerCase()).toContain("verify")
  })

  it("truncates a long summary with an ellipsis", () => {
    const matches: RelatedThreadMatch[] = [
      {
        thread_id: "t1",
        thread_type: null,
        title: "Long one",
        outcome: null,
        summary_text: "x".repeat(500),
        tags: null,
        created_at: "2026-03-15T10:00:00Z",
        similarity: 0.75,
      },
    ]
    const out = formatRelatedThreadsSuffix(matches)
    expect(out).toContain("…")
  })
})

describe("recallRelatedThreads — guards", () => {
  it("returns [] for an empty query without hitting the network", async () => {
    expect(await recallRelatedThreads("", "t1")).toEqual([])
    expect(await recallRelatedThreads("   ", null)).toEqual([])
  })
})

describe("semantic kill-switch (THREAD_RECALL_SEMANTIC_ENABLED, default OFF)", () => {
  it("is OFF by default (Phase 2 ships dark until the migration is applied)", () => {
    // No env var set in the test runner → disabled.
    expect(semanticRecallEnabled()).toBe(false)
  })

  it("short-circuits recall + embed when disabled (no network, even with a real query)", async () => {
    // Flag off → returns immediately before any OpenAI/DB call.
    expect(await recallRelatedThreads("a real meaningful query", "t1")).toEqual([])
    expect(await buildRelatedThreadsSuffix("a real meaningful query", "t1")).toBe("")
    expect(await embedThreadSummary("some-thread-id")).toBe(false)
  })
})
