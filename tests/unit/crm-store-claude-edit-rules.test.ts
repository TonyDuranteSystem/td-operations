import { describe, it, expect } from "vitest"
import { applyTextEdits, describeChange, describeWholeFile, versionNote, isProposalNote, isClaudeNote, PROPOSAL_PREFIX, CLAUDE_EDIT_PREFIX, CONFLICT_PREFIX, EDIT_LIMITS } from "@/lib/crm-store/claude-edit-rules"

const BASE = "# Plan\n\n## Part 53\nold text\n\n## Part 54\nmore\n"

describe("applyTextEdits", () => {
  it("replaces a piece of text that appears once", () => {
    const r = applyTextEdits(BASE, [{ op: "replace", find: "old text", with: "new text" }])
    expect(r).toEqual({ ok: true, text: BASE.replace("old text", "new text"), applied: 1 })
  })
  it("inserts after and before an anchor, and appends / prepends", () => {
    const r = applyTextEdits(BASE, [
      { op: "insert_after", anchor: "## Part 54\nmore\n", text: "\n## Part 55\nadded\n" },
      { op: "insert_before", anchor: "# Plan", text: "<!-- v2 -->\n" },
      { op: "append", text: "END\n" },
      { op: "prepend", text: "START\n" },
    ])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r as { text: string }).text.startsWith("START\n<!-- v2 -->\n# Plan")).toBe(true)
      expect((r as { text: string }).text).toContain("## Part 54\nmore\n\n## Part 55\nadded\n")
      expect((r as { text: string }).text.endsWith("END\n")).toBe(true)
    }
  })
  it("changes nothing when a piece of text is not found (all or nothing)", () => {
    const r = applyTextEdits(BASE, [{ op: "append", text: "x" }, { op: "replace", find: "nope", with: "y" }])
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r as { error: string }).error).toMatch(/Instruction 2: "nope" was not found/)
  })
  it("refuses an ambiguous match unless all is set", () => {
    const text = "a b a"
    const refused = applyTextEdits(text, [{ op: "replace", find: "a", with: "z" }])
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect((refused as { error: string }).error).toMatch(/appears 2 times/)
    expect(applyTextEdits(text, [{ op: "replace", find: "a", with: "z", all: true }])).toEqual({ ok: true, text: "z b z", applied: 1 })
    const anchor = applyTextEdits(text, [{ op: "insert_after", anchor: "a", text: "!" }])
    expect(anchor.ok).toBe(false)
  })
  it("a replacement is literal text (no $ patterns are expanded)", () => {
    const r = applyTextEdits("price: X", [{ op: "replace", find: "X", with: "$& $1 $$" }])
    expect(r).toEqual({ ok: true, text: "price: $& $1 $$", applied: 1 })
  })
  it("a later instruction sees the earlier one's result", () => {
    const r = applyTextEdits("one", [{ op: "replace", find: "one", with: "two" }, { op: "replace", find: "two", with: "three" }])
    expect(r).toEqual({ ok: true, text: "three", applied: 2 })
  })
  it("rejects bad shapes, empty lists and too many instructions", () => {
    expect(applyTextEdits(BASE, []).ok).toBe(false)
    expect(applyTextEdits(BASE, "x").ok).toBe(false)
    expect(applyTextEdits(BASE, [{ op: "replace", find: "", with: "x" }]).ok).toBe(false)
    expect(applyTextEdits(BASE, [{ op: "append", text: "" }]).ok).toBe(false)
    expect(applyTextEdits(BASE, [{ op: "wipe" }]).ok).toBe(false)
    expect(applyTextEdits(BASE, [null]).ok).toBe(false)
    expect(applyTextEdits(BASE, Array.from({ length: EDIT_LIMITS.maxEdits + 1 }, () => ({ op: "append", text: "x" }))).ok).toBe(false)
  })
  it("deleting is a replace with an empty 'with'", () => {
    expect(applyTextEdits("keep drop keep", [{ op: "replace", find: " drop", with: "" }])).toEqual({ ok: true, text: "keep keep", applied: 1 })
  })
  it("refuses a result bigger than the cap", () => {
    const r = applyTextEdits("x", [{ op: "append", text: "y".repeat(EDIT_LIMITS.maxFieldChars) }, { op: "append", text: "y".repeat(EDIT_LIMITS.maxFieldChars) }, ...Array.from({ length: 20 }, () => ({ op: "append", text: "y".repeat(EDIT_LIMITS.maxFieldChars) }))])
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r as { error: string }).error).toMatch(/bigger than 3 MB/)
  })
})

describe("describeChange", () => {
  it("counts added lines and keeps a short sample", () => {
    const c = describeChange("a\nb\nc", "a\nb\nNEW ONE\nNEW TWO\nc")
    expect(c.linesAdded).toBe(2)
    expect(c.linesRemoved).toBe(0)
    expect(c.sample).toEqual(["NEW ONE", "NEW TWO"])
    expect(c.sentence).toBe("2 lines added")
  })
  it("says removed and replaced in plain words", () => {
    expect(describeChange("a\nb\nc", "a\nc").sentence).toBe("1 line removed")
    expect(describeChange("a\nb\nc", "a\nB\nc").sentence).toBe("1 line added, 1 line removed")
  })
  it("says so when nothing changed, and never throws on an empty text", () => {
    expect(describeChange("same", "same").sentence).toBe("no visible change")
    expect(describeChange("", "").sentence).toBe("no visible change")
    expect(describeChange("", "x").sentence).toBe("1 line added")
  })
  it("cuts a long sample line", () => {
    expect(describeChange("a", `a\n${"z".repeat(300)}`).sample[0].length).toBeLessThanOrEqual(100)
  })
})

describe("notes", () => {
  it("builds a short note with the prefix and an optional instruction", () => {
    expect(versionNote(PROPOSAL_PREFIX, "2 lines added", "add Part 55")).toBe("Proposed by Claude: 2 lines added — add Part 55")
    expect(versionNote(CLAUDE_EDIT_PREFIX, "1 line removed")).toBe("Claude edit: 1 line removed")
    expect(versionNote(CLAUDE_EDIT_PREFIX, "x", "y".repeat(2000)).length).toBeLessThanOrEqual(600)
  })
  it("recognises a proposal and any Claude note", () => {
    expect(isProposalNote("Proposed by Claude: x")).toBe(true)
    expect(isProposalNote("Claude edit: x")).toBe(false)
    expect(isProposalNote(null)).toBe(false)
    for (const p of [PROPOSAL_PREFIX, CLAUDE_EDIT_PREFIX, CONFLICT_PREFIX]) expect(isClaudeNote(`${p}x`)).toBe(true)
    expect(isClaudeNote("restored from version 2")).toBe(false)
  })
  it("describes a whole-file save by its sizes", () => {
    expect(describeWholeFile(2048, 4096)).toBe("a new copy of the file (2 KB before, 4 KB now)")
    expect(describeWholeFile(null, 5 * 1048576)).toBe("a new copy of the file (5.0 MB)")
  })
})
