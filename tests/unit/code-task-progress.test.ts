import { describe, it, expect } from "vitest"
// The runner is plain ESM (.mjs) and can't import the repo's TypeScript, so the
// parser lives as a sibling .mjs module — imported here directly for testing.
import {
  toolUseMilestone,
  parseStreamLine,
  milestoneFromEvent,
  finalResultFromEvent,
  reduceMilestones,
  extractFinal,
  // @ts-expect-error — .mjs module has no type declarations; vitest/esbuild resolves it at runtime.
} from "../../scripts/mac-mini/code-task-progress.mjs"

describe("toolUseMilestone", () => {
  it("maps file-editing tools to the editing milestone", () => {
    for (const name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(toolUseMilestone(name, {})).toEqual({ key: "editing", text: "✏️ Editing code…" })
    }
  })

  it("maps read/search tools to the investigating milestone", () => {
    for (const name of ["Read", "Grep", "Glob", "LS"]) {
      expect(toolUseMilestone(name, {})?.key).toBe("investigating")
    }
  })

  it("maps Task to the sub-agent milestone", () => {
    expect(toolUseMilestone("Task", {})?.key).toBe("subagent")
  })

  it("sub-classifies Bash by command: build, test, commit", () => {
    expect(toolUseMilestone("Bash", { command: "npm run build" })?.key).toBe("building")
    expect(toolUseMilestone("Bash", { command: "next build" })?.key).toBe("building")
    expect(toolUseMilestone("Bash", { command: "npx tsc --noEmit" })?.key).toBe("building")
    expect(toolUseMilestone("Bash", { command: "npm run test:unit" })?.key).toBe("testing")
    expect(toolUseMilestone("Bash", { command: "npx vitest run" })?.key).toBe("testing")
    expect(toolUseMilestone("Bash", { command: "git commit -m 'x'" })?.key).toBe("committing")
  })

  it("returns null for git push (runner narrates the push itself)", () => {
    expect(toolUseMilestone("Bash", { command: "git push origin main" })).toBeNull()
    expect(toolUseMilestone("Bash", { command: "ALLOW_X=1 git push origin main" })).toBeNull()
  })

  it("returns null for generic shell and unknown tools", () => {
    expect(toolUseMilestone("Bash", { command: "ls -la" })).toBeNull()
    expect(toolUseMilestone("Bash", {})).toBeNull()
    expect(toolUseMilestone("WebFetch", {})).toBeNull()
  })

  it("does not throw on missing/odd input", () => {
    expect(toolUseMilestone("Bash", null)).toBeNull()
    expect(toolUseMilestone("Bash", { command: 42 })).toBeNull()
  })
})

describe("parseStreamLine", () => {
  it("parses a valid JSON line", () => {
    expect(parseStreamLine('{"type":"system"}')).toEqual({ type: "system" })
  })
  it("returns null for blank or whitespace lines", () => {
    expect(parseStreamLine("")).toBeNull()
    expect(parseStreamLine("   \n")).toBeNull()
    expect(parseStreamLine(undefined)).toBeNull()
  })
  it("returns null for non-JSON garbage", () => {
    expect(parseStreamLine("not json")).toBeNull()
    expect(parseStreamLine("{partial")).toBeNull()
  })
})

describe("milestoneFromEvent", () => {
  it("extracts the first surfaced tool_use from an assistant turn", () => {
    const ev = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: {} }] },
    }
    expect(milestoneFromEvent(ev)?.key).toBe("editing")
  })

  it("returns the FIRST meaningful block when several tools are present", () => {
    const ev = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "let me look" },
          { type: "tool_use", name: "Read", input: {} },
          { type: "tool_use", name: "Edit", input: {} },
        ],
      },
    }
    expect(milestoneFromEvent(ev)?.key).toBe("investigating")
  })

  it("skips non-surfaced tools to find a meaningful one", () => {
    const ev = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "ls" } }, // null
          { type: "tool_use", name: "Bash", input: { command: "npm run build" } }, // building
        ],
      },
    }
    expect(milestoneFromEvent(ev)?.key).toBe("building")
  })

  it("returns null for text-only assistant turns and non-assistant events", () => {
    expect(milestoneFromEvent({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })).toBeNull()
    expect(milestoneFromEvent({ type: "system", subtype: "init" })).toBeNull()
    expect(milestoneFromEvent({ type: "result", result: "done" })).toBeNull()
    expect(milestoneFromEvent(null)).toBeNull()
  })
})

describe("finalResultFromEvent", () => {
  it("reads the final text + success flag from a clean result event", () => {
    expect(finalResultFromEvent({ type: "result", subtype: "success", is_error: false, result: "all done" }))
      .toEqual({ text: "all done", isError: false })
  })

  it("treats is_error:true as an error even when subtype is success (401 case)", () => {
    expect(
      finalResultFromEvent({ type: "result", subtype: "success", is_error: true, result: "401 Invalid auth" }).isError,
    ).toBe(true)
  })

  it("treats a non-success subtype as an error", () => {
    expect(finalResultFromEvent({ type: "result", subtype: "error_max_turns", is_error: false, result: "" }).isError).toBe(true)
    expect(finalResultFromEvent({ type: "result", subtype: "error_during_execution", result: "" }).isError).toBe(true)
  })

  it("returns null for non-result events", () => {
    expect(finalResultFromEvent({ type: "assistant", message: { content: [] } })).toBeNull()
    expect(finalResultFromEvent(null)).toBeNull()
  })
})

describe("reduceMilestones (runner posting logic)", () => {
  it("collapses consecutive duplicates but keeps recurring phases (retry loop)", () => {
    const lines = [
      '{"type":"system","subtype":"init"}',
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: {} }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: {} }] } }), // dup investigating → collapsed
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: {} }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm run test:unit" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: {} }] } }), // edit again after test → re-posted
      "", // blank line tolerated
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }),
    ]
    expect(reduceMilestones(lines)).toEqual([
      "🔍 Reading the code…",
      "✏️ Editing code…",
      "🧪 Running tests…",
      "✏️ Editing code…",
    ])
  })

  it("returns an empty list when no tools are used", () => {
    const lines = [
      '{"type":"system"}',
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "answer" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "answer" }),
    ]
    expect(reduceMilestones(lines)).toEqual([])
  })
})

describe("extractFinal", () => {
  it("returns the last result event's text + error flag", () => {
    const lines = [
      '{"type":"system"}',
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: {} }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "shipped" }),
    ]
    expect(extractFinal(lines)).toEqual({ text: "shipped", isError: false })
  })

  it("returns null when no result event was emitted (crash)", () => {
    const lines = ['{"type":"system"}', '{"type":"assistant","message":{"content":[]}}']
    expect(extractFinal(lines)).toBeNull()
  })
})
