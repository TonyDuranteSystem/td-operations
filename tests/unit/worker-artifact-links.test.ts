/**
 * parseWorkerArtifacts — the shared parser every worker PANEL uses to read the
 * produced-file list off an API response.
 *
 * Sibling of worker-artifacts.test.ts: that one pins the SERVER extraction
 * (`extractArtifact`, which lifts the link out of our own tool output); this one
 * pins the CLIENT side, where the list becomes an <a href> the staff member clicks.
 *
 * WHY IT MATTERS: a malformed entry must be DROPPED, never rendered. A download
 * button that goes nowhere is worse than no button, and it is the same
 * false-capability failure this whole feature exists to remove — the worker saying
 * "here's your file" with nothing behind it. Three panels share this one function
 * (Antonio, 2026-08-05: "must be able to produce files everywhere") precisely so
 * the rule cannot drift between them.
 */

import { describe, it, expect } from "vitest"
import { parseWorkerArtifacts } from "@/lib/ai-agent/worker-artifact-links"

describe("parseWorkerArtifacts", () => {
  it("keeps a well-formed artifact", () => {
    const out = parseWorkerArtifacts([
      { kind: "spreadsheet", url: "https://example.com/a.xlsx", label: "Download spreadsheet" },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].url).toBe("https://example.com/a.xlsx")
    expect(out[0].label).toBe("Download spreadsheet")
  })

  it("keeps several, preserving order", () => {
    const out = parseWorkerArtifacts([
      { kind: "pdf", url: "https://example.com/1.pdf", label: "One" },
      { kind: "spreadsheet", url: "https://example.com/2.xlsx", label: "Two" },
    ])
    expect(out.map((a) => a.label)).toEqual(["One", "Two"])
  })

  // Every one of these reaches the parser in real life: an older deployment that
  // doesn't send the field, an error body, a timeout, a turn that produced nothing.
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a non-array object", { url: "https://example.com/a.pdf" }],
    ["a string", "https://example.com/a.pdf"],
    ["a number", 42],
    ["an empty array", []],
  ])("returns [] for %s", (_label, input) => {
    expect(parseWorkerArtifacts(input)).toEqual([])
  })

  it("drops entries with no url, an empty url, or a non-string url", () => {
    const out = parseWorkerArtifacts([
      { kind: "pdf", label: "no url" },
      { kind: "pdf", url: "", label: "empty url" },
      { kind: "pdf", url: 123, label: "numeric url" },
      { kind: "pdf", url: "https://example.com/ok.pdf", label: "good" },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].label).toBe("good")
  })

  it("drops entries with a missing or non-string label", () => {
    const out = parseWorkerArtifacts([
      { kind: "pdf", url: "https://example.com/a.pdf" },
      { kind: "pdf", url: "https://example.com/b.pdf", label: 7 },
      { kind: "pdf", url: "https://example.com/c.pdf", label: "good" },
    ])
    expect(out.map((a) => a.label)).toEqual(["good"])
  })

  it("drops null/undefined members without throwing", () => {
    const out = parseWorkerArtifacts([
      null,
      undefined,
      { kind: "pdf", url: "https://example.com/a.pdf", label: "good" },
    ])
    expect(out).toHaveLength(1)
  })

  it("keeps an entry whose kind is missing or unknown — kind only picks an icon", () => {
    const out = parseWorkerArtifacts([
      { url: "https://example.com/a.bin", label: "No kind" },
      { kind: "something-new", url: "https://example.com/b.bin", label: "Unknown kind" },
    ])
    expect(out).toHaveLength(2)
  })
})
