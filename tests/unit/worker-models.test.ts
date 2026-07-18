/**
 * Worker model catalog — the gear on every worker panel (dev job a6c3d75b).
 * The validation here is what stops a typo'd or retired model id taking the worker
 * down on EVERY surface at once, so it's worth pinning.
 */

import { describe, it, expect } from "vitest"
import {
  WORKER_MODEL_OPTIONS,
  isAllowedWorkerModel,
  workerModelOption,
  workerModelLabel,
} from "@/lib/ai-agent/worker-models"
import { WORKER_MODEL_DEFAULT } from "@/lib/ai-agent/worker-tools"

describe("model catalog", () => {
  it("offers a short, non-empty list with unique ids", () => {
    expect(WORKER_MODEL_OPTIONS.length).toBeGreaterThan(1)
    expect(WORKER_MODEL_OPTIONS.length).toBeLessThanOrEqual(6) // keep the choice small
    const ids = WORKER_MODEL_OPTIONS.map(o => o.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("every option has a plain-English label and a trade-off hint", () => {
    for (const o of WORKER_MODEL_OPTIONS) {
      expect(o.label.trim()).not.toBe("")
      expect(o.hint.trim()).not.toBe("")
      expect(o.id.trim()).not.toBe("")
    }
  })

  it("includes the model the worker runs today, so 'keep as-is' is selectable", () => {
    expect(isAllowedWorkerModel(WORKER_MODEL_DEFAULT)).toBe(true)
  })
})

describe("isAllowedWorkerModel — the guard against breaking every surface", () => {
  it("accepts a curated id (and tolerates surrounding spaces)", () => {
    const id = WORKER_MODEL_OPTIONS[0].id
    expect(isAllowedWorkerModel(id)).toBe(true)
    expect(isAllowedWorkerModel(`  ${id}  `)).toBe(true)
  })

  it("rejects a typo, an unknown id, and non-strings", () => {
    expect(isAllowedWorkerModel("claude-sonnet-4-6-TYPO")).toBe(false)
    expect(isAllowedWorkerModel("gpt-4o")).toBe(false)
    expect(isAllowedWorkerModel("")).toBe(false)
    expect(isAllowedWorkerModel("   ")).toBe(false)
    expect(isAllowedWorkerModel(null)).toBe(false)
    expect(isAllowedWorkerModel(undefined)).toBe(false)
    expect(isAllowedWorkerModel(42)).toBe(false)
    expect(isAllowedWorkerModel({ id: "claude-opus-4-8" })).toBe(false)
  })
})

describe("labels", () => {
  it("resolves a known id to its option and label", () => {
    const o = WORKER_MODEL_OPTIONS[0]
    expect(workerModelOption(o.id)?.label).toBe(o.label)
    expect(workerModelLabel(o.id)).toBe(o.label)
  })

  it("falls back to the raw id rather than going blank on an unknown value", () => {
    expect(workerModelLabel("some-future-model")).toBe("some-future-model")
    expect(workerModelLabel(null)).toBe("default")
    expect(workerModelLabel("")).toBe("default")
  })
})
