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

  it("WORKER_TOOLS is the read-only AGENT_TOOLS subset PLUS propose_action + codebase_read + codebase_search + memory_save", () => {
    // propose_action only QUEUES (never executes); codebase_read/codebase_search
    // are strictly read-only repo-source access; memory_save is a knowledge-only
    // write (decision_memory) authorized for the worker in Phase 3 — it never
    // touches client/business data. Everything else is the read-only research
    // subset (which now includes the read-only memory_recall).
    expect(WORKER_TOOLS.length).toBe(WORKER_READ_ONLY_TOOL_NAMES.size + 4)
    const workerNames = new Set(WORKER_TOOLS.map((t) => t.name))
    for (const name of WORKER_READ_ONLY_TOOL_NAMES) {
      expect(workerNames.has(name)).toBe(true)
    }
    expect(workerNames.has("propose_action")).toBe(true)
    expect(workerNames.has("codebase_read")).toBe(true)
    expect(workerNames.has("codebase_search")).toBe(true)
    expect(workerNames.has("memory_save")).toBe(true)
    // memory_recall is a read — it must arrive via the read-only allow-list.
    expect(WORKER_READ_ONLY_TOOL_NAMES.has("memory_recall")).toBe(true)
    expect(workerNames.has("memory_recall")).toBe(true)
  })

  it("memory_save is NOT in the read-only allow-list (it's a write, wired separately)", () => {
    // Keeping it out of WORKER_READ_ONLY_TOOL_NAMES means the write-prefix scan
    // still governs that set; memory_save is dispatched explicitly like
    // propose_action. (Its name dodges the write-prefix scan, so this guards intent.)
    expect(WORKER_READ_ONLY_TOOL_NAMES.has("memory_save")).toBe(false)
  })

  it("propose_action is NOT in the read-only allow-list (it's a proposer, not a reader)", () => {
    // Keeping it out of WORKER_READ_ONLY_TOOL_NAMES means the write-prefix scan
    // above still governs that set, and propose_action is wired separately.
    expect(WORKER_READ_ONLY_TOOL_NAMES.has("propose_action")).toBe(false)
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

  it("routes codebase_read to the repo reader (NOT rejected)", async () => {
    // package.json exists at the repo root and is not a blocked path.
    const result = await executeWorkerTool("codebase_read", { path: "package.json" })
    expect(result).not.toContain("not permitted")
    expect(result).toContain("# package.json")
  })

  it("routes codebase_search to the repo grep (NOT rejected)", async () => {
    const result = await executeWorkerTool("codebase_search", {
      pattern: "executeWorkerTool",
      directory: "lib/ai-agent",
    })
    expect(result).not.toContain("not permitted")
    expect(result).toContain("worker-tools.ts")
  })

  it("routes memory_save (knowledge-only write) — NOT rejected as out-of-allow-list", async () => {
    // Empty params hit input validation in the tool itself (no network), proving
    // the dispatch routes to executeTool rather than the read-only guard.
    const result = await executeWorkerTool("memory_save", {})
    expect(result).not.toContain("not permitted")
    expect(result).toContain("situation")
  })

  it("routes memory_recall (read) — NOT rejected as out-of-allow-list", async () => {
    const result = await executeWorkerTool("memory_recall", {})
    expect(result).not.toContain("not permitted")
    expect(result).toContain("query")
  })
})
