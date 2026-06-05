/**
 * Hermes ↔ Claude bridge — Phase C: thread-type tool routing.
 * Pairs with lib/ai-agent/thread-routing.ts.
 *
 * Pins the contract that each thread type sees exactly the right tool surface:
 * client_audit can never reach codebase tools, internal_ops can never reach
 * client (CRM) data, bug_report gets codebase + CRM, and action_request keeps
 * propose_action.
 */

import { describe, it, expect } from "vitest"
import {
  getToolsForThreadType,
  toolNamesForThreadType,
  getPromptAddendumForThreadType,
  normalizeThreadType,
  THREAD_TYPES,
  DEFAULT_THREAD_TYPE,
  CRM_READ_TOOL_NAMES,
  CODEBASE_TOOL_NAMES,
  KB_SOP_TOOL_NAMES,
} from "@/lib/ai-agent/thread-routing"
import { WORKER_TOOLS } from "@/lib/ai-agent/worker-tools"

const namesFor = (type: string) => new Set(getToolsForThreadType(type).map((t) => t.name))

describe("thread routing — getToolsForThreadType", () => {
  it("returns ToolDefs drawn only from WORKER_TOOLS", () => {
    const workerNames = new Set(WORKER_TOOLS.map((t) => t.name))
    for (const type of THREAD_TYPES) {
      for (const t of getToolsForThreadType(type)) {
        expect(workerNames.has(t.name)).toBe(true)
      }
    }
  })

  it("investigation gets the FULL worker tool set (incl. codebase + propose)", () => {
    const names = namesFor("investigation")
    expect(names.size).toBe(WORKER_TOOLS.length)
    expect(names.has("propose_action")).toBe(true)
    expect(names.has("codebase_read")).toBe(true)
  })

  it("action_request gets the full set and ALWAYS keeps propose_action", () => {
    const names = namesFor("action_request")
    expect(names.size).toBe(WORKER_TOOLS.length)
    expect(names.has("propose_action")).toBe(true)
  })

  it("bug_report = codebase tools + CRM read tools, no propose, no gmail/drive", () => {
    const names = namesFor("bug_report")
    for (const n of CODEBASE_TOOL_NAMES) expect(names.has(n)).toBe(true)
    for (const n of CRM_READ_TOOL_NAMES) expect(names.has(n)).toBe(true)
    expect(names.has("propose_action")).toBe(false)
    expect(names.has("gmail_search")).toBe(false)
    expect(names.has("drive_search")).toBe(false)
  })

  it("client_audit = CRM read tools ONLY (no code, no propose, client-facing)", () => {
    const names = namesFor("client_audit")
    for (const n of CRM_READ_TOOL_NAMES) expect(names.has(n)).toBe(true)
    for (const n of CODEBASE_TOOL_NAMES) expect(names.has(n)).toBe(false)
    expect(names.has("propose_action")).toBe(false)
    expect(names.has("gmail_search")).toBe(false)
    expect(names.size).toBe(CRM_READ_TOOL_NAMES.length)
  })

  it("internal_ops = codebase + KB/SOP only, NO client data (no CRM/gmail/drive)", () => {
    const names = namesFor("internal_ops")
    for (const n of CODEBASE_TOOL_NAMES) expect(names.has(n)).toBe(true)
    for (const n of KB_SOP_TOOL_NAMES) expect(names.has(n)).toBe(true)
    for (const n of CRM_READ_TOOL_NAMES) expect(names.has(n)).toBe(false)
    expect(names.has("gmail_search")).toBe(false)
    expect(names.has("drive_search")).toBe(false)
    expect(names.has("propose_action")).toBe(false)
  })

  it("an unknown thread type falls back to the full (investigation) set", () => {
    expect(namesFor("nonsense_type")).toEqual(namesFor(DEFAULT_THREAD_TYPE))
    expect(namesFor("")).toEqual(namesFor(DEFAULT_THREAD_TYPE))
  })
})

describe("thread routing — normalizeThreadType", () => {
  it("passes through known types and defaults unknown ones", () => {
    expect(normalizeThreadType("bug_report")).toBe("bug_report")
    expect(normalizeThreadType("client_audit")).toBe("client_audit")
    expect(normalizeThreadType("garbage")).toBe(DEFAULT_THREAD_TYPE)
    expect(normalizeThreadType(undefined)).toBe(DEFAULT_THREAD_TYPE)
    expect(normalizeThreadType(42)).toBe(DEFAULT_THREAD_TYPE)
  })
})

describe("thread routing — prompt addenda", () => {
  it("investigation has no addendum; the others each carry type-specific guidance", () => {
    expect(getPromptAddendumForThreadType("investigation")).toBe("")
    expect(getPromptAddendumForThreadType("action_request")).toContain("propose_action")
    expect(getPromptAddendumForThreadType("bug_report").toLowerCase()).toContain("reproduction")
    expect(getPromptAddendumForThreadType("client_audit").toLowerCase()).toContain("client-facing")
    expect(getPromptAddendumForThreadType("internal_ops").toLowerCase()).toContain("do not pull client data")
  })

  it("toolNamesForThreadType and getToolsForThreadType agree", () => {
    for (const type of THREAD_TYPES) {
      const byName = toolNamesForThreadType(type)
      const byTool = new Set(getToolsForThreadType(type).map((t) => t.name))
      // every emitted tool is allowed; allow-list may include names not in WORKER_TOOLS? no — all are.
      for (const n of byTool) expect(byName.has(n)).toBe(true)
    }
  })
})
