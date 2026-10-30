/**
 * The investigator reads strangers' text, so what it may hold is pinned here. Add a send/write flag to the
 * options, or drop a tool from the exclude list, and a test fails.
 */
import { describe, it, expect } from "vitest"
import { buildInvestigatorWorkerOptions, INVESTIGATOR_EXCLUDED_TOOLS } from "@/lib/finance/investigator-options"
import { INVESTIGATOR_SYSTEM_PROMPT } from "@/lib/finance/feed-investigation"
import { WORKER_TOOLS, READ_BANK_FEEDS_TOOL } from "@/lib/ai-agent/worker-tools"

describe("buildInvestigatorWorkerOptions", () => {
  it("is exactly this set of options — nothing that sends, writes or runs SQL", () => {
    expect(buildInvestigatorWorkerOptions()).toEqual({
      surface: "bank-feed-investigator",
      systemPromptOverride: INVESTIGATOR_SYSTEM_PROMPT,
      maxIterations: 10,
      excludeTools: ["memory_save", "codebase_read", "codebase_search", "propose_action"],
      machineOutput: true,
      enableBankFeedRead: true,
      enableCallReads: true,
      enableClientThreadRead: true,
    })
  })

  it("excludes memory_save by its REAL name — a wrong name would remove nothing", () => {
    const names = new Set(WORKER_TOOLS.map((t) => t.name))
    for (const tool of ["memory_save", "codebase_read", "codebase_search"]) {
      expect(names.has(tool)).toBe(true) // the name exists in the base list, so excluding it does something
      expect(INVESTIGATOR_EXCLUDED_TOOLS).toContain(tool)
    }
  })

  it("never turns on any send / SQL / note-write / full-reach flag", () => {
    const o = buildInvestigatorWorkerOptions() as Record<string, unknown>
    for (const flag of ["enableSlackSend", "enableTeamChatSend", "enableEmailSend", "enableDbRead", "enableCodeTasks", "enableCrmNotes", "enableFullToolReach", "enableClientThreadTag", "enableCalendly", "enableWebSearch", "enableThreadRecall"]) {
      expect(o[flag]).toBeUndefined()
    }
  })

  it("the Bank Feed tool is NOT in the base list (flag-gated) and its name starts with read_ so its results are fenced as untrusted", () => {
    expect(WORKER_TOOLS.some((t) => t.name === READ_BANK_FEEDS_TOOL.name)).toBe(false)
    expect(READ_BANK_FEEDS_TOOL.name.startsWith("read_")).toBe(true)
  })
})
