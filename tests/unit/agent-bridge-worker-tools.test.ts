/**
 * Hermes ↔ Claude bridge worker — read-only safety guarantees.
 * dev_task 1a0d1354. Pairs with lib/ai-agent/worker-tools.ts.
 *
 * These tests are the structural defense against a future change accidentally
 * adding a write tool to the worker's allow-list. The Phase 1 contract is
 * "worker is read-only"; if these break, that contract has been broken too.
 */

import { describe, it, expect } from "vitest"
import { WORKER_READ_ONLY_TOOL_NAMES, WORKER_TOOLS, executeWorkerTool } from "@/lib/ai-agent/worker-tools"
import { AGENT_TOOLS } from "@/lib/ai-agent/tools"

describe("Hermes ↔ Claude bridge — worker tool allow-list", () => {
  it("contains at least one tool", () => {
    expect(WORKER_READ_ONLY_TOOL_NAMES.size).toBeGreaterThan(0)
    expect(WORKER_TOOLS.length).toBeGreaterThan(0)
  })

  it("contains zero write-shaped tool names (defense against accidental additions)", () => {
    // Any tool whose name starts with one of these prefixes is presumed to
    // mutate state. If a real read tool is misnamed it can be renamed; the
    // safer default is to reject it here.
    const WRITE_NAME_PREFIXES = ["send_", "create_", "update_", "advance_", "save_", "delete_", "insert_", "mark_"]
    for (const name of WORKER_READ_ONLY_TOOL_NAMES) {
      for (const prefix of WRITE_NAME_PREFIXES) {
        expect(
          name.startsWith(prefix),
          `Worker allow-list contains write-shaped tool "${name}" (prefix "${prefix}"). Phase 1 worker must be read-only.`,
        ).toBe(false)
      }
    }
  })

  it("explicitly excludes run_sql_query (raw SQL is unnecessary for research surface)", () => {
    // search_* tools cover the legitimate use cases; raw SQL would bypass
    // schema-level validation and add risk for no upside.
    expect(WORKER_READ_ONLY_TOOL_NAMES.has("run_sql_query")).toBe(false)
  })

  it("every allow-listed name resolves to a real tool in AGENT_TOOLS", () => {
    const realNames = new Set(AGENT_TOOLS.map((t) => t.name))
    for (const name of WORKER_READ_ONLY_TOOL_NAMES) {
      expect(realNames.has(name), `Worker allow-list references unknown tool "${name}".`).toBe(true)
    }
  })

  it("WORKER_TOOLS is exactly the AGENT_TOOLS subset matching the allow-list", () => {
    expect(WORKER_TOOLS.length).toBe(WORKER_READ_ONLY_TOOL_NAMES.size)
    const workerNames = new Set(WORKER_TOOLS.map((t) => t.name))
    for (const name of WORKER_READ_ONLY_TOOL_NAMES) {
      expect(workerNames.has(name)).toBe(true)
    }
  })
})

describe("Hermes ↔ Claude bridge — executeWorkerTool guard", () => {
  it("rejects any tool name not in the allow-list (defense-in-depth)", async () => {
    // Defense beyond the schema-level filter: even if sonnet somehow names a
    // tool outside its visible list, the executor still refuses.
    const result = await executeWorkerTool("send_email", { to: "x@y.z", subject: "x", body: "x" })
    expect(result).toContain("not permitted")
    expect(result).toContain("send_email")
  })

  it("rejects an unknown name (typo or invented tool)", async () => {
    const result = await executeWorkerTool("totally_made_up_tool", {})
    expect(result).toContain("not permitted")
  })
})
