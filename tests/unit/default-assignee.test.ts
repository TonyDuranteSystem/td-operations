/**
 * defaultTaskAssignee — env-var-backed fallback with "Luca" as the safe
 * default. Tests guarantee the env override works AND the no-env path stays
 * production-compatible.
 */

import { describe, it, expect, afterEach } from "vitest"
import { defaultTaskAssignee } from "@/lib/tasks/default-assignee"

const ORIGINAL = process.env.DEFAULT_TASK_ASSIGNEE

describe("defaultTaskAssignee", () => {
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.DEFAULT_TASK_ASSIGNEE
    } else {
      process.env.DEFAULT_TASK_ASSIGNEE = ORIGINAL
    }
  })

  it("returns 'Luca' when env is unset (production-safe default)", () => {
    delete process.env.DEFAULT_TASK_ASSIGNEE
    expect(defaultTaskAssignee()).toBe("Luca")
  })

  it("returns the env value when set", () => {
    process.env.DEFAULT_TASK_ASSIGNEE = "Marco"
    expect(defaultTaskAssignee()).toBe("Marco")
  })

  it("trims whitespace", () => {
    process.env.DEFAULT_TASK_ASSIGNEE = "  Antonio  "
    expect(defaultTaskAssignee()).toBe("Antonio")
  })

  it("falls back when env is empty string", () => {
    process.env.DEFAULT_TASK_ASSIGNEE = ""
    expect(defaultTaskAssignee()).toBe("Luca")
  })

  it("falls back when env is whitespace only", () => {
    process.env.DEFAULT_TASK_ASSIGNEE = "   "
    expect(defaultTaskAssignee()).toBe("Luca")
  })
})
