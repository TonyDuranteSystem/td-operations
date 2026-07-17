/**
 * Worker model resolution (WS5): env-overridable default + per-call override,
 * so a model trial is a config change, not a code edit — and no behavior change
 * until something sets it.
 */

import { describe, it, expect, afterEach } from "vitest"
import { resolveWorkerModel, WORKER_MODEL_DEFAULT } from "@/lib/ai-agent/worker-tools"

afterEach(() => {
  delete process.env.WORKER_MODEL
})

describe("resolveWorkerModel", () => {
  it("defaults to the current worker model when nothing is set", () => {
    delete process.env.WORKER_MODEL
    expect(resolveWorkerModel()).toBe(WORKER_MODEL_DEFAULT)
    expect(resolveWorkerModel(null)).toBe(WORKER_MODEL_DEFAULT)
    expect(resolveWorkerModel("")).toBe(WORKER_MODEL_DEFAULT)
    expect(resolveWorkerModel("   ")).toBe(WORKER_MODEL_DEFAULT)
  })

  it("uses the env default when set and no per-call override", () => {
    process.env.WORKER_MODEL = "claude-sonnet-5"
    expect(resolveWorkerModel()).toBe("claude-sonnet-5")
  })

  it("a per-call override wins over the env and the default", () => {
    process.env.WORKER_MODEL = "claude-sonnet-5"
    expect(resolveWorkerModel("claude-opus-4-8")).toBe("claude-opus-4-8")
  })

  it("trims a per-call override", () => {
    expect(resolveWorkerModel("  claude-sonnet-5  ")).toBe("claude-sonnet-5")
  })
})
