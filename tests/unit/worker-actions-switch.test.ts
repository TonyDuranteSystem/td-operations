/**
 * Worker action rail switch (2026-07-10) — the single reversible OFF gate that
 * stops every worker/helper from queuing actions or launching code.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { workerActionsEnabled, WORKER_ACTIONS_OFF_MESSAGE } from "@/lib/ai-agent/worker-actions-switch"

const ORIGINAL = process.env.WORKER_ACTIONS_ENABLED

describe("workerActionsEnabled", () => {
  beforeEach(() => {
    delete process.env.WORKER_ACTIONS_ENABLED
  })
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.WORKER_ACTIONS_ENABLED
    else process.env.WORKER_ACTIONS_ENABLED = ORIGINAL
  })

  it("defaults OFF when the env var is unset", () => {
    expect(workerActionsEnabled()).toBe(false)
  })

  it("is ON only for the exact string 'true'", () => {
    process.env.WORKER_ACTIONS_ENABLED = "true"
    expect(workerActionsEnabled()).toBe(true)
  })

  it("stays OFF for any other truthy-looking value", () => {
    for (const v of ["1", "TRUE", "yes", "on", ""]) {
      process.env.WORKER_ACTIONS_ENABLED = v
      expect(workerActionsEnabled()).toBe(false)
    }
  })

  it("exposes a plain-English refusal message that names no removed tool", () => {
    expect(WORKER_ACTIONS_OFF_MESSAGE).toMatch(/switched off/i)
    expect(WORKER_ACTIONS_OFF_MESSAGE).not.toMatch(/propose_action|start_code_task/i)
  })
})
